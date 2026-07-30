const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');

describe('E2E Order Lifecycle & Escrow Release Flow', () => {
  let buyerToken, vendorToken, riderToken;
  let buyerId, vendorId, shopId, productId, riderId;
  let orderId;
  const testOtp = '4829';

  beforeAll(async () => {
    // 1. Clean up & Seed test database
    await db.query('TRUNCATE TABLE orders, order_items, vendor_withdrawals, shops, users RESTART IDENTITY CASCADE;');

    // 2. Create User Accounts (Buyer, Vendor, Rider)
    const buyerRes = await db.query(`
      INSERT INTO users (name, phone, role) 
      VALUES ('Buyer Bob', '+254711111111', 'buyer') RETURNING id;
    `);
    buyerId = buyerRes.rows[0].id;

    const vendorRes = await db.query(`
      INSERT INTO users (name, phone, role) 
      VALUES ('Vendor Alice', '+254722222222', 'vendor') RETURNING id;
    `);
    vendorId = vendorRes.rows[0].id;

    const riderRes = await db.query(`
      INSERT INTO users (name, phone, role) 
      VALUES ('Rider Charlie', '+254733333333', 'rider') RETURNING id;
    `);
    riderId = riderRes.rows[0].id;

    // 3. Create Shop & Product
    const shopRes = await db.query(`
      INSERT INTO shops (vendor_id, name, balance, location) 
      VALUES ($1, 'Tech Zone', 0.00, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326)) 
      RETURNING id;
    `, [vendorId]);
    shopId = shopRes.rows[0].id;

    const prodRes = await db.query(`
      INSERT INTO products (shop_id, name, price, stock) 
      VALUES ($1, 'Wireless Earbuds', 1500.00, 10) 
      RETURNING id;
    `, [shopId]);
    productId = prodRes.rows[0].id;

    // Mock Authentication Tokens (adjust to your JWT signing logic)
    buyerToken = 'Bearer mock-buyer-token';
    vendorToken = 'Bearer mock-vendor-token';
    riderToken = 'Bearer mock-rider-token';
  });

  afterAll(async () => {
    await db.end(); // Close DB pool
  });

  // --------------------------------------------------------------------------
  // STEP 1: CHECKOUT & ORDER CREATION
  // --------------------------------------------------------------------------
  it('Step 1: Buyer initiates checkout and creates pending order', async () => {
    const payload = {
      shopId,
      items: [{ productId, quantity: 2, price: 1500.00 }],
      deliveryLat: -1.286389,
      deliveryLng: 36.817223,
      paymentPhone: '+254711111111'
    };

    const res = await request(app)
      .post('/api/orders/checkout')
      .set('Authorization', buyerToken)
      .send(payload);

    expect(res.statusCode).toEqual(201);
    expect(res.body.success).toBe(true);
    expect(res.body.order).toHaveProperty('id');
    expect(res.body.order.status).toBe('pending_payment');
    expect(parseFloat(res.body.order.total_amount)).toBeGreaterThan(3000.00); // 3000 + delivery fee

    orderId = res.body.order.id;
  });

  // --------------------------------------------------------------------------
  // STEP 2: M-PESA STK CALLBACK (PAYMENT CONFIRMATION)
  // --------------------------------------------------------------------------
  it('Step 2: M-Pesa STK push callback transitions order to escrow_held', async () => {
    // Inject custom OTP into database for deterministic test validation
    await db.query(`UPDATE orders SET otp_code = $1 WHERE id = $2`, [testOtp, orderId]);

    const callbackPayload = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_260520211002545913',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 3150.00 },
              { Name: 'MpesaReceiptNumber', Value: 'QFH7123456' },
              { Name: 'PhoneNumber', Value: 254711111111 }
            ]
          }
        }
      }
    };

    const res = await request(app)
      .post(`/api/payments/mpesa-callback?orderId=${orderId}`)
      .send(callbackPayload);

    expect(res.statusCode).toEqual(200);

    // Assert order state in DB
    const dbCheck = await db.query('SELECT status, escrow_status FROM orders WHERE id = $1', [orderId]);
    expect(dbCheck.rows[0].status).toBe('paid');
    expect(dbCheck.rows[0].escrow_status).toBe('escrow_held');
  });

  // --------------------------------------------------------------------------
  // STEP 3: VENDOR ACCEPTS & ASSIGNS RIDER
  // --------------------------------------------------------------------------
  it('Step 3: Vendor accepts order and assigns a delivery rider', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/accept`)
      .set('Authorization', vendorToken)
      .send({ riderId });

    expect(res.statusCode).toEqual(200);
    expect(res.body.order.rider_id).toBe(riderId);
    expect(res.body.order.status).toBe('in_transit');
  });

  // --------------------------------------------------------------------------
  // STEP 4: RIDER LIVE LOCATION UPDATES (PostGIS)
  // --------------------------------------------------------------------------
  it('Step 4: Rider streams current coordinates to PostGIS location column', async () => {
    const locationPayload = {
      lat: -1.288000,
      lng: 36.818000
    };

    const res = await request(app)
      .patch(`/api/orders/${orderId}/location`)
      .set('Authorization', riderToken)
      .send(locationPayload);

    expect(res.statusCode).toEqual(200);

    // Verify PostGIS ST_AsText conversion
    const postgisCheck = await db.query(
      `SELECT ST_AsText(current_location) AS loc FROM orders WHERE id = $1`,
      [orderId]
    );
    expect(postgisCheck.rows[0].loc).toBe('POINT(36.818 -1.288)');
  });

  // --------------------------------------------------------------------------
  // STEP 5: OTP HANDSHAKE & ESCROW RELEASE
  // --------------------------------------------------------------------------
  it('Step 5a: Rejects incorrect OTP attempt', async () => {
    const res = await request(app)
      .post(`/api/payments/release-escrow`)
      .set('Authorization', riderToken)
      .send({ orderId, otp: '0000' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/invalid otp/i);
  });

  it('Step 5b: Validates correct OTP, delivers order, and releases escrow to vendor balance', async () => {
    const res = await request(app)
      .post(`/api/payments/release-escrow`)
      .set('Authorization', riderToken)
      .send({ orderId, otp: testOtp });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);

    // Assert final database state across tables
    const finalOrder = await db.query('SELECT status, escrow_status FROM orders WHERE id = $1', [orderId]);
    expect(finalOrder.rows[0].status).toBe('delivered');
    expect(finalOrder.rows[0].escrow_status).toBe('released');

    const shopBalance = await db.query('SELECT balance FROM shops WHERE id = $1', [shopId]);
    expect(parseFloat(shopBalance.rows[0].balance)).toBe(3000.00); // Items total without delivery fee
  });
});
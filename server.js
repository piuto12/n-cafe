require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const verifyPasskeys = require('./passkey-verifier');

function readEnvironmentValue(name) {
  const value = process.env[name];
  return typeof value === 'string'
    ? value.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    : '';
}

const app = express();
const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET;
const BILL_PIN_INDEX_KEY = JWT_SECRET;
function createBillPinLookup(passkey) {
  return crypto.createHmac('sha256', BILL_PIN_INDEX_KEY).update(passkey).digest('hex');
}
const missingEnvironment = ['JWT_SECRET', 'ADMIN_PASSWORD', 'OPERATOR_PIN']
  .filter((name) => !process.env[name]);
if (missingEnvironment.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missingEnvironment.join(', ')}. ` +
    'Add them in Render Dashboard > Environment > Environment Variables. ' +
    'JWT_SECRET must contain at least 32 random characters.'
  );
}
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 random characters.');
}
const isHostedProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const configuredMongoUri = readEnvironmentValue('MONGODB_URI');
if (isHostedProduction && !configuredMongoUri) {
  throw new Error(
    'MONGODB_URI is required in hosted production. Configure a MongoDB Atlas connection string in Render.'
  );
}
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'n-cafe-data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'n_cafe.db');
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const rateBuckets = new Map();
const paymentIntents = new Map();

app.disable('x-powered-by');
if (isHostedProduction) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: allowedOrigin || false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.use(express.json({ limit: '256kb' }));

function rateLimit(windowMs, max, keyPrefix) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    const now = Date.now();
    const current = rateBuckets.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - current.startedAt)) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

app.use(rateLimit(60 * 1000, 120, 'global'));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  if (/\.(?:db|sqlite|sqlite3|env|log|sql|zip|bak)$/i.test(req.path) ||
      req.path.startsWith('/.')) {
    return res.status(404).end();
  }
  const publicFiles = new Set([
    '/index.html',
    '/admin.html',
    '/scanner.html',
    '/app.js',
    '/customer.js',
    '/admin.js',
    '/scanner.js',
    '/receipt-print.js',
    '/resource-loader.js',
    '/theme.js',
    '/style.css'
  ]);
  if (!req.path.startsWith('/api/') && req.method === 'GET' &&
      !publicFiles.has(req.path) &&
      !/^\/assets\/[^/]+\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$/i.test(req.path)) {
    if (!['/', '/admin', '/scanner', '/health'].includes(req.path)) return res.status(404).end();
  }
  next();
});

// Serve static web pages
app.use(express.static(path.join(__dirname), {
  dotfiles: 'deny',
  index: false,
  setHeaders(res, filePath) {
    if (path.extname(filePath).toLowerCase() !== '.html') {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

// --- DATABASE INITIALIZATION & SCHEMA CREATION ---
class DB {
  constructor() {
    this.mongoUri = configuredMongoUri;
    this.isMongo = Boolean(this.mongoUri);
    this.isPostgres = false;
    this.ready = false;
    this.startupError = null;
    this.queue = Promise.resolve();

    if (this.isMongo) {
      this.mongoClient = null;
      this.mongoDb = null;
      return;
    }

    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
      try {
        const { Client } = require('pg');
        this.isPostgres = true;
        this.pgClient = new Client({
          connectionString: dbUrl,
          ssl: {
            rejectUnauthorized: true,
            ca: process.env.DATABASE_CA
          }
        });
      } catch (err) {
        console.error("PostgreSQL driver ('pg') failed to load. Defaulting to SQLite.", err);
        this.isPostgres = false;
        this.sqliteDb = new sqlite3.Database(DB_PATH);
      }
    } else {
      this.sqliteDb = new sqlite3.Database(DB_PATH);
    }
  }

  normalizeRow(row) {
    if (!row) return row;
    const mapping = {
      customername: 'customerName',
      customerphone: 'customerPhone',
      totalamount: 'totalAmount',
      bookingtime: 'bookingTime',
      expirytime: 'expiryTime',
      redeemedtime: 'redeemedTime',
      paymentmethod: 'paymentMethod',
      paymentstatus: 'paymentStatus',
      fooditemid: 'foodItemId',
      lastpurchasedate: 'lastPurchaseDate'
    };
    const newRow = {};
    for (const key in row) {
      if (mapping[key]) {
        newRow[mapping[key]] = row[key];
      } else {
        newRow[key] = row[key];
      }
    }
    return newRow;
  }

  connect(callback) {
    if (this.isMongo) {
      const connectMongo = () => {
        const mongoOptions = {
          connectTimeoutMS: 10000,
          serverSelectionTimeoutMS: 10000,
          family: 4,
          retryWrites: true
        };
        if (this.mongoUri.startsWith('mongodb+srv://')) {
          mongoOptions.tls = true;
          mongoOptions.tlsAllowInvalidCertificates = false;
        }
        this.mongoClient = new MongoClient(this.mongoUri, mongoOptions);
        this.mongoClient.connect()
          .then(() => {
            this.mongoDb = this.mongoClient.db(process.env.MONGODB_DATABASE || 'n_cafe');
            this.startupError = null;
            console.log('Connected to MongoDB database successfully.');
            callback(null);
          })
          .catch((err) => {
            this.startupError = err;
            const scheme = this.mongoUri.split(':')[0] || 'unknown';
            const safeTarget = this.mongoUri
              .replace(/:\/\/[^@]+@/, '://***@')
              .replace(/\?.*$/, '');
            const authenticationFailed = err &&
              (err.code === 18 || /bad auth|authentication failed/i.test(err.message || ''));
            if (authenticationFailed) {
              console.error(
                `MongoDB authentication failed (${scheme}, ${safeTarget}). ` +
                'Check the Atlas database username, password, and URL encoding in MONGODB_URI. ' +
                'The server will not retry until the credentials are corrected and redeployed.'
              );
              return;
            }
            console.error(
              `MongoDB connection failed (${scheme}, ${safeTarget}); ` +
              `retrying in 5 seconds: ${err.message}`
            );
            setTimeout(connectMongo, 5000);
          });
      };
      connectMongo();
    } else if (this.isPostgres) {
      this.pgClient.connect((err) => {
        if (err) {
          console.error("Failed to connect to PostgreSQL:", err);
          callback(err);
        } else {
          console.log("Connected to PostgreSQL database successfully.");
          callback(null);
        }
      });
    } else {
      console.log("Connected to SQLite database at:", DB_PATH);
      callback(null);
    }
  }

  translateQuery(sql) {
    if (!this.isPostgres) return sql;

    let translated = sql;

    // Translate SQLite UPSERT (INSERT OR REPLACE) to PostgreSQL ON CONFLICT DO UPDATE
    if (translated.toUpperCase().includes('INSERT OR REPLACE INTO')) {
      translated = translated.replace(/INSERT OR REPLACE INTO/i, 'INSERT INTO');
      translated += ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
    }

    // Replace "?" placeholders with "$1", "$2", etc. for Postgres
    let index = 1;
    while (translated.includes('?')) {
      translated = translated.replace('?', '$' + index);
      index++;
    }

    return translated;
  }

  serialize(cb) {
    if (this.isMongo || this.isPostgres) {
      cb();
    } else {
      this.sqliteDb.serialize(cb);
    }
  }

  run(sql, params, cb) {
    if (typeof params === 'function') {
      cb = params;
      params = [];
    }
    params = params || [];
    if (this.isMongo) {
      this.mongoRun(sql, params, cb);
      return;
    }
    const translatedSql = this.translateQuery(sql);

    if (this.isPostgres) {
      this.queue = this.queue.then(() => {
        return new Promise((resolve) => {
          this.pgClient.query(translatedSql, params, (err, res) => {
            if (cb) cb(err);
            resolve();
          });
        });
      });
    } else {
      this.sqliteDb.run(sql, params, cb);
    }
  }

  get(sql, params, cb) {
    if (typeof params === 'function') {
      cb = params;
      params = [];
    }
    params = params || [];
    if (this.isMongo) {
      this.mongoGet(sql, params, cb);
      return;
    }
    const translatedSql = this.translateQuery(sql);

    if (this.isPostgres) {
      this.queue = this.queue.then(() => {
        return new Promise((resolve) => {
          this.pgClient.query(translatedSql, params, (err, res) => {
            if (err) {
              if (cb) cb(err);
            } else {
              const row = res.rows ? res.rows[0] : null;
              if (cb) cb(null, this.normalizeRow(row));
            }
            resolve();
          });
        });
      });
    } else {
      this.sqliteDb.get(sql, params, cb);
    }
  }

  all(sql, params, cb) {
    if (typeof params === 'function') {
      cb = params;
      params = [];
    }
    params = params || [];
    if (this.isMongo) {
      this.mongoAll(sql, params, cb);
      return;
    }
    const translatedSql = this.translateQuery(sql);

    if (this.isPostgres) {
      this.queue = this.queue.then(() => {
        return new Promise((resolve) => {
          this.pgClient.query(translatedSql, params, (err, res) => {
            if (err) {
              if (cb) cb(err);
            } else {
              const rows = (res.rows || []).map(r => this.normalizeRow(r));
              if (cb) cb(null, rows);
            }
            resolve();
          });
        });
      });
    } else {
      this.sqliteDb.all(sql, params, cb);
    }
  }

  prepare(sql) {
    if (this.isMongo) {
      const self = this;
      const operations = [];
      return {
        run(params, cb) {
          operations.push({ params, cb });
        },
        finalize(cb) {
          const next = (index) => {
            if (index >= operations.length) return cb && cb();
            const operation = operations[index];
            self.mongoRun(sql, operation.params, (err) => {
              if (operation.cb) operation.cb(err);
              if (err) return cb && cb(err);
              next(index + 1);
            });
          };
          next(0);
        }
      };
    }
    const translatedSql = this.translateQuery(sql);
    const self = this;

    if (this.isPostgres) {
      return {
        run(params, cb) {
          self.pgClient.query(translatedSql, params, (err) => {
            if (cb) cb(err);
          });
        },
        finalize(cb) {
          if (cb) cb();
        }
      };
    } else {
      const stmt = this.sqliteDb.prepare(sql);
      return {
        run(params, cb) {
          stmt.run(params, cb);
        },
        finalize(cb) {
          stmt.finalize(cb);
        }
      };
    }
  }

  mongoCollection(table) {
    return this.mongoDb.collection(table);
  }

  mongoTable(sql) {
    const match = sql.match(/(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+)/i);
    return match && match[1];
  }

  mongoWhere(sql, params) {
    const match = sql.match(/WHERE\s+(.+?)(?:\s+ORDER BY|\s+GROUP BY|$)/i);
    if (!match) return {};
    const where = {};
    let index = 0;
    match[1].split(/\s+AND\s+/i).forEach(condition => {
      const part = condition.match(/(?:LOWER\()?([a-zA-Z_]+)\)?\s*(=|!=|<=|>=|<|>)\s*(\?|[-+]?\d+(?:\.\d+)?|'.*?'|".*?")/i);
      if (!part) return;
      if (/^LOWER\(/i.test(condition)) return;
      const valueToken = part[3];
      let value;
      if (valueToken === '?') {
        value = params[index++];
      } else if (/^['"]/.test(valueToken)) {
        value = valueToken.slice(1, -1);
      } else {
        value = Number(valueToken);
      }
      where[part[1]] = part[2] === '=' ? value : {
        '!=': { $ne: value }, '<=': { $lte: value }, '>=': { $gte: value },
        '<': { $lt: value }, '>': { $gt: value }
      }[part[2]];
    });
    return where;
  }

  mongoRun(sql, params, cb) {
    if (!this.mongoDb) return cb && cb(new Error('MongoDB connection is not ready.'));
    const statement = sql.trim().replace(/\s+/g, ' ');
    const done = (err) => cb && cb(err);
    if (/^(CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)/i.test(statement)) return done(null);
    const table = this.mongoTable(statement);
    if (!table) return done(new Error(`Unsupported MongoDB statement: ${statement}`));
    const collection = this.mongoCollection(table);

    if (/^INSERT OR REPLACE INTO settings/i.test(statement)) {
      const insertMatch = statement.match(
        /^INSERT OR REPLACE INTO settings\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/i
      );
      if (!insertMatch) return done(new Error(`Unsupported settings insert: ${statement}`));
      const fields = insertMatch[1].split(',').map((field) => field.trim());
      const values = insertMatch[2].split(',').map((value) => value.trim());
      if (fields.length !== values.length) {
        return done(new Error(`Invalid settings insert: ${statement}`));
      }
      let parameterIndex = 0;
      const document = Object.fromEntries(fields.map((field, index) => {
        const token = values[index];
        const value = token === '?'
          ? params[parameterIndex++]
          : /^'.*'$/.test(token) || /^".*"$/.test(token)
            ? token.slice(1, -1)
            : token;
        return [field, value];
      }));
      if (document.key === undefined) {
        return done(new Error(`Settings insert has no key: ${statement}`));
      }
      return collection.updateOne({ key: document.key }, { $set: document }, { upsert: true })
        .then(() => done(null)).catch(done);
    }
    if (/^INSERT INTO/i.test(statement)) {
      const fieldsMatch = statement.match(/INSERT INTO\s+[a-z_]+\s*\(([^)]+)\)/i);
      const fields = fieldsMatch ? fieldsMatch[1].split(',').map(field => field.trim()) : [];
      const document = Object.fromEntries(fields.map((field, index) => [field, params[index]]));
      const idField = document.id !== undefined ? 'id' : document.key !== undefined ? 'key' : null;
      const operation = idField
        ? collection.updateOne({ [idField]: document[idField] }, { $set: document }, { upsert: true })
        : collection.insertOne(document);
      return operation.then(() => done(null)).catch(done);
    }
    if (/^DELETE FROM/i.test(statement)) {
      return collection.deleteMany(this.mongoWhere(statement, params)).then(() => done(null)).catch(done);
    }
    if (/^UPDATE food_items SET stock = stock -/i.test(statement)) {
      const quantity = Number(params[0]);
      return collection.updateOne({ id: params[2] }, [
        { $set: { stock: { $subtract: ['$stock', quantity] } } },
        { $set: { listed: { $cond: [{ $lte: ['$stock', 0] }, 0, '$listed'] } } }
      ]).then(() => done(null)).catch(done);
    }
    if (/^UPDATE/i.test(statement)) {
      const updateMatch = statement.match(/^UPDATE\s+[a-z_]+\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
      if (!updateMatch) return done(new Error(`Unsupported MongoDB update: ${statement}`));
      const assignments = updateMatch[1].split(/\s*,\s*/);
      const update = {};
      let parameterIndex = 0;
      assignments.forEach(assignment => {
        const assignmentMatch = assignment.match(/^([a-zA-Z_]+)\s*=\s*(.+)$/);
        if (!assignmentMatch) return;
        const field = assignmentMatch[1];
        const rawValue = assignmentMatch[2].trim();
        if (rawValue === '?') {
          update[field] = params[parameterIndex++];
        } else if (/^'.*'$/.test(rawValue) || /^".*"$/.test(rawValue)) {
          update[field] = rawValue.slice(1, -1);
        }
        if (table === 'food_items' && field === 'listed') {
          update[field] = Boolean(update[field]) ? 1 : 0;
        }
      });
      const where = this.mongoWhere(`WHERE ${updateMatch[2]}`, params.slice(parameterIndex));
      return collection.updateMany(where, { $set: update }).then(() => done(null)).catch(done);
    }
    return done(new Error(`Unsupported MongoDB statement: ${statement}`));
  }

  async mongoRows(sql, params) {
    if (!this.mongoDb) throw new Error('MongoDB connection is not ready.');
    const statement = sql.trim().replace(/\s+/g, ' ');
    const table = this.mongoTable(statement);
    const collection = this.mongoCollection(table);
    let rows = await collection.find(this.mongoWhere(statement, params)).toArray();
    if (/LOWER\(customerName\)/i.test(statement)) {
      const requestedName = String(params[0] || '').toLowerCase();
      rows = rows.filter(row => String(row.customerName || '').toLowerCase() === requestedName);
    }
    rows = rows.map(row => this.normalizeRow(row));
    const countMatch = statement.match(/^SELECT COUNT\(\*\)\s+as\s+([a-zA-Z_]+)/i);
    if (countMatch) return [{ [countMatch[1]]: rows.length }];
    const sumMatch = statement.match(/^SELECT\s+([a-zA-Z_]+),\s*SUM\(([^)]+)\)\s+as\s+([a-zA-Z_]+)/i);
    if (sumMatch) {
      const grouped = new Map();
      rows.forEach(row => grouped.set(row[sumMatch[1]], (grouped.get(row[sumMatch[1]]) || 0) + Number(row[sumMatch[2]] || 0)));
      return [...grouped.entries()].map(([key, value]) => ({ [sumMatch[1]]: key, [sumMatch[3]]: value }));
    }
    const orderMatch = statement.match(/ORDER BY\s+([a-zA-Z_]+)\s+(ASC|DESC)/i);
    if (orderMatch) {
      const direction = orderMatch[2].toUpperCase() === 'DESC' ? -1 : 1;
      rows.sort((a, b) => (a[orderMatch[1]] > b[orderMatch[1]] ? direction : -direction));
    }
    const projectionMatch = statement.match(/^SELECT\s+(.+?)\s+FROM/i);
    if (projectionMatch && projectionMatch[1] !== '*') {
      const fields = projectionMatch[1].split(',').map(field => field.trim());
      return rows.map(row => Object.fromEntries(fields.map(field => {
        const aliasMatch = field.match(/(?:\s+AS\s+)?([a-zA-Z_]+)$/i);
        const alias = aliasMatch[1];
        const sourceExpression = field.split(/\s+AS\s+/i)[0].trim();
        const source = sourceExpression.split('.').pop();
        if (/COALESCE\(listed,\s*1\)/i.test(sourceExpression)) return [alias, row.listed ?? 1];
        return [alias, row[source] ?? (source === 'listed' ? 1 : null)];
      })));
    }
    return rows;
  }

  mongoGet(sql, params, cb) {
    this.mongoRows(sql, params).then(rows => cb(null, rows[0] || null)).catch(err => cb(err));
  }

  mongoAll(sql, params, cb) {
    this.mongoRows(sql, params).then(rows => cb(null, rows)).catch(err => cb(err));
  }
}

const db = new DB();

db.connect((err) => {
  if (err) {
    console.error('Failed to initialize database connection:', err);
  } else {
    Promise.resolve(initializeDatabase())
      .then(() => {
        db.ready = true;
        console.log('Database initialization complete.');
      })
      .catch((initErr) => {
        console.error('Failed to initialize database:', initErr);
      });
  }
});

async function initializeMongoDatabase() {
  const settings = db.mongoCollection('settings');
  const foodItems = db.mongoCollection('food_items');
  const ingredients = db.mongoCollection('ingredients');

  const defaults = [
    ['admin_password', bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10)],
    ['scanner_pin', bcrypt.hashSync(process.env.OPERATOR_PIN, 10)],
    ['account_details', JSON.stringify({
      name: 'N Cafe Hills Kitchen Services',
      bank: 'State Bank of India',
      accNo: '39485710293',
      ifsc: 'SBIN0008472',
      upiId: 'ncafe.canteen@okaxis',
      ticketExpiryHours: 5,
      logoImage: '',
      heroBannerImage: '',
      logoBackgroundColor: '#1b4d3e'
    })],
    ['special_offer', JSON.stringify({
      active: false,
      title: 'Special Hills Combo',
      desc: 'Masala Dosa + Misty Hills Filter Coffee combo at a special discount!',
      price: 90,
      image: 'assets/south_indian_meals.png'
    })]
  ];

  await Promise.all(defaults.map(([key, value]) =>
    settings.updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true })
  ));
  await settings.updateOne(
    { key: 'food_listing_migration_v1' },
    { $setOnInsert: { key: 'food_listing_migration_v1', value: 'completed' } },
    { upsert: true }
  );
  await settings.updateOne(
    { key: 'food_listing_type_migration_v2' },
    { $setOnInsert: { key: 'food_listing_type_migration_v2', value: 'completed' } },
    { upsert: true }
  );
  await foodItems.updateMany(
    { listed: { $in: [true, false] } },
    [{ $set: { listed: { $cond: [{ $eq: ['$listed', true] }, 1, 0] } } }]
  );

  const seedFoods = [
    ['FD-101', 'Masala Dosa', 60, 50, 'Breakfast', 'Veg', 'assets/masala_dosa.png', 'Crispy golden dosa served with chutney and sambar.'],
    ['FD-102', 'Filter Coffee', 25, 100, 'Beverages', 'Veg', 'assets/filter_coffee.png', 'Traditional South Indian filter coffee.'],
    ['FD-103', 'Vada Sambar Combo', 60, 25, 'Breakfast', 'Veg', 'assets/vada_combo.png', 'Crispy vada with hot sambar.'],
    ['FD-104', 'Meals Thali', 90, 30, 'Lunch', 'Veg', 'assets/south_indian_meals.png', 'Complete South Indian vegetarian meal.']
  ];
  await Promise.all(seedFoods.map(([id, name, price, stock, category, isveg, image, details]) =>
    foodItems.updateOne(
      { id },
      { $setOnInsert: { id, name, price, stock, category, isveg, image, details, offer_price: null, listed: stock > 0 ? 1 : 0 } },
      { upsert: true }
    )
  ));
  await Promise.all([
    ingredients.createIndex({ id: 1 }, { unique: true }),
    foodItems.createIndex({ id: 1 }, { unique: true }),
    foodItems.createIndex({ listed: 1, stock: 1 }),
    db.mongoCollection('bookings').createIndex(
      { customerName: 1, bookingTime: -1 },
      { name: 'bookings_customer_name_ci_time', collation: { locale: 'en', strength: 2 } }
    ),
    db.mongoCollection('bookings').createIndex(
      { customerPhone: 1, bookingTime: -1 },
      { name: 'bookings_customer_phone_time' }
    ),
    db.mongoCollection('bookings').createIndex(
      { customerName: 1, status: 1, passkeyLookup: 1, bookingTime: -1, expiryTime: 1 },
      { name: 'bookings_pending_customer_name_pin_time', collation: { locale: 'en', strength: 2 } }
    ),
    db.mongoCollection('bookings').createIndex(
      { customerPhone: 1, status: 1, passkeyLookup: 1, bookingTime: -1, expiryTime: 1 },
      { name: 'bookings_pending_customer_phone_pin_time' }
    ),
    db.mongoCollection('bookings').createIndex({ id: 1 }, { name: 'bookings_id' }),
    db.mongoCollection('locks').createIndex({ expiryTime: 1, foodItemId: 1 })
  ]);
  console.log('MongoDB collections initialized.');
}

function initializeDatabase() {
  if (db.isMongo) {
    return initializeMongoDatabase();
  }
  db.ready = true;
  db.serialize(() => {
    // 1. Food Items Table
    db.run(`CREATE TABLE IF NOT EXISTS food_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER NOT NULL,
      category TEXT NOT NULL,
      isveg TEXT NOT NULL,
      image TEXT NOT NULL,
      details TEXT,
      listed INTEGER NOT NULL DEFAULT 1
    )`);

    // Migration: Add offer_price column if it does not exist
    db.run("ALTER TABLE food_items ADD COLUMN offer_price REAL DEFAULT NULL", (err) => {
      // Ignore error if column already exists
    });
    db.run("ALTER TABLE food_items ADD COLUMN listed INTEGER NOT NULL DEFAULT 1", (err) => {
      // Ignore error if column already exists
    });

    // 2. Bookings Table
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      customerName TEXT NOT NULL,
      customerPhone TEXT NOT NULL,
      passkey TEXT NOT NULL,
      passkeyLookup TEXT,
      items TEXT NOT NULL, -- JSON string
      totalAmount REAL NOT NULL,
      paymentMethod TEXT NOT NULL,
      paymentStatus TEXT NOT NULL,
      bookingTime TEXT NOT NULL,
      expiryTime TEXT NOT NULL,
      status TEXT NOT NULL, -- pending, redeemed, expired, cancelled
      redeemedTime TEXT
    )`);
    db.run("ALTER TABLE bookings ADD COLUMN passkeyLookup TEXT", () => {});
    db.run("CREATE INDEX IF NOT EXISTS bookings_customer_name_lower_time_idx ON bookings (LOWER(customerName), bookingTime DESC)");
    db.run("CREATE INDEX IF NOT EXISTS bookings_customer_phone_time_idx ON bookings (customerPhone, bookingTime DESC)");
    db.run("CREATE INDEX IF NOT EXISTS bookings_pending_customer_name_time_idx ON bookings (LOWER(customerName), status, bookingTime DESC, expiryTime)");
    db.run("CREATE INDEX IF NOT EXISTS bookings_pending_customer_phone_time_idx ON bookings (customerPhone, status, bookingTime DESC, expiryTime)");
    db.run("CREATE INDEX IF NOT EXISTS bookings_pending_customer_name_pin_time_idx ON bookings (LOWER(customerName), status, passkeyLookup, bookingTime DESC, expiryTime)");
    db.run("CREATE INDEX IF NOT EXISTS bookings_pending_customer_phone_pin_time_idx ON bookings (customerPhone, status, passkeyLookup, bookingTime DESC, expiryTime)");

    // 3. Transactions (Cash Ledger) Table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL, -- sale, purchase, expense
      title TEXT NOT NULL,
      amount REAL NOT NULL,
      timestamp TEXT NOT NULL,
      details TEXT
    )`);

    // 4. Ingredients Table
    db.run(`CREATE TABLE IF NOT EXISTS ingredients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stock REAL NOT NULL,
      unit TEXT NOT NULL,
      lastPurchaseDate TEXT
    )`);

    // 5. Temporary Stock Locks Table (Note: BIGINT support for Postgres millisecond timestamps)
    db.run("DROP TABLE IF EXISTS locks");
    db.run(`CREATE TABLE IF NOT EXISTS locks (
      id TEXT,
      foodItemId TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      expiryTime BIGINT NOT NULL,
      PRIMARY KEY (id, foodItemId)
    )`);
    db.run("CREATE INDEX IF NOT EXISTS locks_expiry_food_idx ON locks (expiryTime, foodItemId)");

    // 6. Settings Table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // --- SEED INITIAL DATA IF EMPTY ---
    seedDatabase();
  });
}

function seedDatabase() {
  db.get("SELECT value FROM settings WHERE key = 'food_listing_migration_v1'", (migrationErr, migrationRow) => {
    if (migrationErr) {
      console.error('Failed to check food listing migration:', migrationErr);
    } else if (!migrationRow) {
      db.run("UPDATE food_items SET listed = 1", (updateErr) => {
        if (updateErr) {
          console.error('Failed to normalize legacy food visibility:', updateErr);
          return;
        }
        db.run(
          "INSERT INTO settings (key, value) VALUES ('food_listing_migration_v1', 'completed')",
          (insertErr) => {
            if (insertErr) console.error('Failed to record food listing migration:', insertErr);
          }
        );
      });
    }
  });

  db.get("SELECT COUNT(*) as count FROM settings WHERE key = 'admin_password'", (err, row) => {
    if (err) return console.error(err);
    if (parseInt(row.count, 10) === 0) {
      if (!process.env.ADMIN_PASSWORD || !process.env.OPERATOR_PIN) {
        return console.error('ADMIN_PASSWORD and OPERATOR_PIN must be configured before first startup.');
      }
      console.log('Seeding configured security credentials and settings...');
      const salt = bcrypt.genSaltSync(10);
      const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, salt);
      const scannerHash = bcrypt.hashSync(process.env.OPERATOR_PIN, salt);

      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)", [adminHash]);
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('scanner_pin', ?)", [scannerHash]);

      const defaultAcc = {
        name: 'N Cafe Hills Kitchen Services',
        bank: 'State Bank of India',
        accNo: '39485710293',
        ifsc: 'SBIN0008472',
        upiId: 'ncafe.canteen@okaxis',
        ticketExpiryHours: 5,
        logoImage: '',
        heroBannerImage: '',
        logoBackgroundColor: '#1b4d3e'
      };
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('account_details', ?)", [JSON.stringify(defaultAcc)]);
    }
  });

  // Seed special offer default configuration if missing
  db.get("SELECT COUNT(*) as count FROM settings WHERE key = 'special_offer'", (err, row) => {
    if (err) return console.error(err);
    if (!row || parseInt(row.count, 10) === 0) {
      console.log('Seeding default special offer banner settings...');
      const defaultOffer = {
        active: false,
        title: 'Special Hills Combo',
        desc: 'Masala Dosa + Misty Hills Filter Coffee combo at a special discount!',
        price: 90,
        image: 'assets/south_indian_meals.png'
      };
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('special_offer', ?)", [JSON.stringify(defaultOffer)]);
    }
  });

  db.serialize(() => {
    db.run(
      "UPDATE food_items SET image = 'assets/' || image WHERE image IN ('masala_dosa.png', 'idli_sambar.png', 'filter_coffee.png', 'vada_combo.png', 'south_indian_meals.png', 'rava_dosa.png')",
      [],
      err => {
        if (err) console.error('Failed to correct seeded food image paths:', err);
      }
    );

    const defaultFoods = [
      ['FD-101', 'Masala Dosa Special', 80, 20, 'Breakfast', 'Veg', 'assets/masala_dosa.png', 'Crispy dosa with potato filling served with sambar and coconut chutney.'],
      ['FD-102', 'Idli Sambar (2 Pcs)', 50, 15, 'Breakfast', 'Veg', 'assets/idli_sambar.png', 'Soft steamed rice cakes served with hot sambar and tomato chutney.'],
      ['FD-103', 'Misty Hills Filter Coffee', 30, 40, 'Beverages', 'Veg', 'assets/filter_coffee.png', 'Traditional South Indian frothy chicory blended coffee.'],
      ['FD-104', 'Vada Sambar Combo', 60, 25, 'Breakfast', 'Veg', 'assets/vada_combo.png', 'Crispy fried lentil donuts served with side sambar and dips.'],
      ['FD-105', 'Nilgiri South Indian Meals', 120, 15, 'Lunch', 'Veg', 'assets/south_indian_meals.png', 'Traditional South Indian mini meals with rice, sambar, rasam, poriyal, appalam, and curd.'],
      ['FD-106', 'Steaming Hot Rava Dosa', 90, 15, 'Dinner', 'Veg', 'assets/rava_dosa.png', 'Crispy semolina dosa spiced with black pepper, cumin, and green chillies.']
    ];
    defaultFoods.forEach(food => {
      db.get("SELECT COUNT(*) as count FROM food_items WHERE id = ?", [food[0]], (err, checkRow) => {
        if (!err && checkRow && parseInt(checkRow.count, 10) === 0) {
          console.log(`Seeding default food item: ${food[1]}`);
          db.run("INSERT INTO food_items (id, name, price, stock, category, isveg, image, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", food);
        }
      });
    });
  });

  db.get("SELECT COUNT(*) as count FROM ingredients", (err, row) => {
    if (err) return console.error(err);
    if (parseInt(row.count, 10) === 0) {
      console.log('Seeding default ingredients...');
      const defaultIngs = [
        ['ING-001', 'Rice Dosa Batter', 15.5, 'kg', new Date().toISOString()],
        ['ING-002', 'Filter Coffee Beans', 5.0, 'kg', new Date().toISOString()],
        ['ING-003', 'Sambhar Spices & Masala', 8.2, 'kg', new Date().toISOString()],
        ['ING-004', 'Lentil Vada Batter', 10.0, 'kg', new Date().toISOString()]
      ];
      const stmt = db.prepare("INSERT INTO ingredients (id, name, stock, unit, lastPurchaseDate) VALUES (?, ?, ?, ?, ?)");
      defaultIngs.forEach(ing => stmt.run(ing));
      stmt.finalize();
    }
  });
}

function cleanText(value, maxLength) {
      if (typeof value !== 'string') return null;
      const text = value.replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
      return text && text.length <= maxLength ? text : null;
}

function validPhone(value) {
      return typeof value === 'string' && /^[0-9]{10,15}$/.test(value);
}

function normalizeBookingItems(items, catalog) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 30) return null;
      const normalized = [];
      for (const item of items) {
        const id = cleanText(item && item.foodItemId, 32);
        const quantity = Number(item && item.quantity);
        if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) return null;
        const food = catalog.find(entry => entry.id === id);
        if (!food) return null;
        const offerPrice = Number(food.offerPrice ?? food.offer_price);
        const regularPrice = Number(food.price);
        normalized.push({
          foodItemId: food.id,
          name: food.name,
          quantity,
          price: offerPrice > 0 && offerPrice < regularPrice ? offerPrice : regularPrice
        });
      }
        return normalized;
}

function getActiveSpecialOfferCatalogEntry(callback) {
  db.get("SELECT value FROM settings WHERE key = 'special_offer'", (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(null, null);

      try {
        const offer = JSON.parse(row.value);
        if (!offer || typeof offer !== 'object') return callback(null, null);
        const title = cleanText(offer.title, 120);
        const price = Number(offer.price);
        if (!offer.active || !title || !Number.isFinite(price) || price <= 0) {
          return callback(null, null);
        }
        callback(null, {
          id: 'FD-SPECIAL',
          name: title,
          price,
          offerPrice: null
        });
      } catch (error) {
        callback(error);
      }
  });
}

// --- SECURE JWT AUTHENTICATION MIDDLEWARE ---
function authenticateToken(allowedRoles = []) {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Token expired or invalid.' });
      }
      
      if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        return res.status(403).json({ error: 'Unauthorized role.' });
      }

      req.user = user;
      next();
    });
  };
}

app.use('/api', (req, res, next) => {
  if (!db.ready) {
    if (db.startupError) {
      return res.status(503).json({
        error: 'Database unavailable. Check the MongoDB Atlas connection, database user, and Network Access settings, then try again.'
      });
    }
    return res.status(503).json({ error: 'Database is still starting. Please try again in a moment.' });
  }
  next();
});

app.get('/health', (req, res) => {
  if (db.ready) return res.json({ status: 'ok', database: 'connected' });
  res.status(503).json({
    status: 'degraded',
    database: db.startupError ? 'unavailable' : 'starting',
    message: db.startupError
      ? 'MongoDB is unavailable. Check MONGODB_URI, Atlas Network Access, and database credentials.'
      : 'Database initialization is still in progress.'
  });
});

// --- BACKGROUND EXPIRED HOLDS CLEANUP ---
setInterval(() => {
  if (!db.ready) return;
  const now = Date.now();
  db.run("DELETE FROM locks WHERE expiryTime < ?", [now], function(err) {
    if (err) console.error("Error pruning expired locks:", err);
  });
}, 10000); // Clean up locks every 10 seconds

// --- SECURE ROUTING & HTML SERVING ---
app.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/scanner', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'scanner.html'));
});

// --- API AUTH ENDPOINTS ---

// Admin Login
app.post('/api/auth/login-admin', rateLimit(15 * 60 * 1000, 10, 'admin-login'), (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required.' });
  }

  db.get("SELECT value FROM settings WHERE key = 'admin_password'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Database error.' });
    }
    const match = bcrypt.compareSync(password, row.value);
    if (match) {
      const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: 'Incorrect Admin Password.' });
    }
  });
});

// Operator Login
app.post('/api/auth/login-operator', rateLimit(15 * 60 * 1000, 20, 'operator-login'), (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'PIN required.' });
  }

  db.get("SELECT value FROM settings WHERE key = 'scanner_pin'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Database error.' });
    }
    const match = bcrypt.compareSync(pin, row.value);
    if (match) {
      const token = jwt.sign({ role: 'operator' }, JWT_SECRET, { expiresIn: '12h' });
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: 'Incorrect Operator PIN.' });
    }
  });
});

// Change Security Credentials (Admin auth required)
app.post('/api/auth/change-credentials', authenticateToken(['admin']), (req, res) => {
  const { currentPassword, password, pin } = req.body;
  if (!currentPassword || !password || !pin) {
    return res.status(400).json({ error: 'Current password, new password, and PIN are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Admin password must be at least 6 characters.' });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'Operator PIN must be exactly 4 digits.' });
  }

  // Verify current password first
  db.get("SELECT value FROM settings WHERE key = 'admin_password'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Database error.' });
    }
    const match = bcrypt.compareSync(currentPassword, row.value);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect current Admin password (security key mismatch).' });
    }

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const pinHash = bcrypt.hashSync(pin, salt);

    db.serialize(() => {
      db.run("UPDATE settings SET value = ? WHERE key = 'admin_password'", [passwordHash]);
      db.run("UPDATE settings SET value = ? WHERE key = 'scanner_pin'", [pinHash], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to update credentials.' });
        }
        res.json({ success: true, message: 'Security credentials updated successfully.' });
      });
    });
  });
});

// Admin Image Upload Endpoint (Admin only)
app.post('/api/upload-image', authenticateToken(['admin']), (req, res) => {
  const { imageName, base64Data } = req.body;
  if (!imageName || !base64Data) {
    return res.status(400).json({ error: 'Missing parameters.' });
  }

  try {
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Clean, 'base64');
    
    const originalName = path.basename(imageName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    const safeName = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
    const targetPath = path.join(__dirname, 'assets', safeName);

    fs.writeFile(targetPath, buffer, (err) => {
      if (err) {
        console.error("Failed to write image file:", err);
        return res.status(500).json({ error: 'Failed to save image file on server.' });
      }
      res.json({ success: true, imagePath: `assets/${safeName}` });
    });
  } catch (e) {
    console.error("Image upload parsing error:", e);
    res.status(500).json({ error: 'Failed to process image data.' });
  }
});

// --- API ACCOUNT SETTINGS ENDPOINTS ---

// Get Settings (Public bank info + credentials metadata)
app.get('/api/settings', (req, res) => {
  db.get("SELECT value FROM settings WHERE key = 'account_details'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Failed to retrieve settings.' });
    }
    res.json(JSON.parse(row.value));
  });
});

// Save Account Details (Admin auth required)
app.post('/api/settings', authenticateToken(['admin']), (req, res) => {
  const { name, bank, accNo, ifsc, upiId, ticketExpiryHours, logoImage, heroBannerImage, logoBackgroundColor } = req.body;
  if (!name || !bank || !accNo || !ifsc || !upiId) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const safeImagePath = (value) => typeof value === 'string' && /^assets\/[A-Za-z0-9._-]+$/.test(value) ? value : '';
  const safeColor = (value) => typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : '#1b4d3e';
  const newAcc = {
    name,
    bank,
    accNo,
    ifsc,
    upiId,
    ticketExpiryHours: ticketExpiryHours ? parseInt(ticketExpiryHours, 10) : 5,
    logoImage: safeImagePath(logoImage),
    heroBannerImage: safeImagePath(heroBannerImage),
    logoBackgroundColor: safeColor(logoBackgroundColor)
  };
  db.run("UPDATE settings SET value = ? WHERE key = 'account_details'", [JSON.stringify(newAcc)], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to save account settings.' });
    }
    res.json({ success: true, message: 'Account details saved successfully.' });
  });
});

// Get Special Offer (Public)
app.get('/api/special-offer', (req, res) => {
  db.get("SELECT value FROM settings WHERE key = 'special_offer'", (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to retrieve special offer settings.' });
    }
    if (!row) {
      const defaultOffer = {
        active: false,
        title: 'Special Hills Combo',
        desc: 'Masala Dosa + Misty Hills Filter Coffee combo at a special discount!',
        price: 90,
        image: 'assets/south_indian_meals.png'
      };
      return res.json(defaultOffer);
    }
    try {
      const offer = JSON.parse(row.value);
      res.json(offer);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse special offer settings.' });
    }
  });
});

// Save Special Offer (Admin only)
app.post('/api/special-offer', authenticateToken(['admin']), (req, res) => {
  const { active, title, desc, price, image } = req.body;
  if (title === undefined || price === undefined) {
    return res.status(400).json({ error: 'Missing title or price.' });
  }

  const offerData = {
    active: !!active,
    title,
    desc: desc || '',
    price: Number(price) || 0,
    image: image || 'assets/south_indian_meals.png'
  };

  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('special_offer', ?)", [JSON.stringify(offerData)], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to save special offer settings.' });
    }
    res.json({ success: true, specialOffer: offerData });
  });
});

// --- API CATALOG / FOOD ENDPOINTS ---

// Get Food Catalog (Takes temporary locks into account)
app.get('/api/food-items', (req, res) => {
  const now = Date.now();
  const completeCatalog = (foods, locked) => {
    const lockMap = {};
    locked.forEach((lock) => {
      lockMap[lock.foodItemId || lock._id] = lock.lockedQty;
    });

    res.json(foods.map((food) => ({
      ...food,
      offerPrice: food.offer_price,
      availableStock: Math.max(0, food.stock - (lockMap[food.id] || 0))
    })));
  };

  if (db.isMongo) {
    Promise.all([
      db.mongoCollection('food_items')
        .find({ listed: 1, stock: { $gt: 0 } })
        .toArray(),
      db.mongoCollection('locks')
        .aggregate([
          { $match: { expiryTime: { $gt: now } } },
          { $group: { _id: '$foodItemId', lockedQty: { $sum: '$quantity' } } }
        ])
        .toArray()
    ])
      .then(([foods, locks]) => completeCatalog(foods.map((food) => db.normalizeRow(food)), locks))
      .catch((err) => res.status(500).json({ error: err.message }));
    return;
  }

  const queryAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
  Promise.all([
    queryAll("SELECT * FROM food_items WHERE listed = 1 AND stock > 0"),
    queryAll("SELECT foodItemId, SUM(quantity) as lockedQty FROM locks WHERE expiryTime > ? GROUP BY foodItemId", [now])
  ])
    .then(([foods, locks]) => completeCatalog(foods, locks))
    .catch((err) => res.status(500).json({ error: err.message }));
});

// Get the complete food catalog for the admin inventory view.
app.get('/api/admin/food-items', authenticateToken(['admin']), (req, res) => {
  if (db.isMongo) {
    db.mongoCollection('food_items').find({}).toArray()
      .then((foods) => res.json(foods.map((food) => ({
        ...food,
        offerPrice: food.offer_price,
        listed: food.listed === true || Number(food.listed) === 1
      }))))
      .catch((err) => res.status(500).json({ error: err.message }));
    return;
  }

  db.all("SELECT id, name, price, stock, category, isveg, image, details, offer_price, COALESCE(listed, 1) AS listed FROM food_items", (err, foods) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(foods.map(f => ({ ...f, offerPrice: f.offer_price, listed: Boolean(f.listed) })));
  });
});

// Add Food Item (Admin required)
app.post('/api/food-items', authenticateToken(['admin']), (req, res) => {
  const { id, name, price, stock, category, isveg, image, details, offerPrice, listed } = req.body;
  if (!id || !name || price == null || stock == null || !category || !isveg || !image) {
    return res.status(400).json({ error: 'Invalid food payload.' });
  }

  const parsedOfferPrice = (offerPrice === '' || offerPrice === undefined || offerPrice === null) ? null : parseFloat(offerPrice);

  db.run(
    "INSERT INTO food_items (id, name, price, stock, category, isveg, image, details, offer_price, listed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, name, price, stock, category, isveg, image, details || '', parsedOfferPrice, listed === false ? 0 : 1],
    function(err) {
      if (err) return res.status(500).json({ error: err.message || 'ID already exists or DB error.' });
      res.json({ success: true, id });
    }
  );
});

// Edit Food Item (Admin required)
app.put('/api/food-items/:id', authenticateToken(['admin']), (req, res) => {
  const { name, price, stock, category, isveg, image, details, offerPrice, listed } = req.body;
  const foodId = req.params.id;
  const parsedOfferPrice = (offerPrice === '' || offerPrice === undefined || offerPrice === null) ? null : parseFloat(offerPrice);

  db.run(
    "UPDATE food_items SET name = ?, price = ?, stock = ?, category = ?, isveg = ?, image = ?, details = ?, offer_price = ?, listed = ? WHERE id = ?",
    [name, price, stock, category, isveg, image, details || '', parsedOfferPrice, listed === false || Number(stock) <= 0 ? 0 : 1, foodId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Item updated successfully.' });
    }
  );
});

// Delete Food Item (Admin required)
app.delete('/api/food-items/:id', authenticateToken(['admin']), (req, res) => {
  const foodId = req.params.id;
  db.run("DELETE FROM food_items WHERE id = ?", [foodId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Item deleted.' });
  });
});

// --- API INVENTORY / INGREDIENTS ENDPOINTS ---

// Get Ingredients
app.get('/api/ingredients', (req, res) => {
  db.all("SELECT * FROM ingredients", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add Ingredient (Admin required)
app.post('/api/ingredients', authenticateToken(['admin']), (req, res) => {
  const { id, name, stock, unit } = req.body;
  if (!id || !name || stock == null || !unit) {
    return res.status(400).json({ error: 'Missing parameters.' });
  }

  db.run(
    "INSERT INTO ingredients (id, name, stock, unit, lastPurchaseDate) VALUES (?, ?, ?, ?, ?)",
    [id, name, stock, unit, new Date().toISOString()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message || 'Ingredient exists or DB error.' });
      res.json({ success: true });
    }
  );
});

// Update Ingredient Stock (Admin required)
app.put('/api/ingredients/:id', authenticateToken(['admin']), (req, res) => {
  const { stock, name, unit } = req.body;
  const ingId = req.params.id;

  db.run(
    "UPDATE ingredients SET name = ?, stock = ?, unit = ? WHERE id = ?",
    [name, stock, unit, ingId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Delete Ingredient (Admin required)
app.delete('/api/ingredients/:id', authenticateToken(['admin']), (req, res) => {
  const ingId = req.params.id;
  db.run("DELETE FROM ingredients WHERE id = ?", [ingId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Ingredient deleted.' });
  });
});

// --- API STOCK LOCKS ENDPOINTS ---

// Create Stock Hold Lock
app.post('/api/locks', async (req, res) => {
  const { cartItems } = req.body; // Array of { id, quantity }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Cart is empty.' });
  }

  const requested = new Map();
  for (const item of cartItems) {
    if (!item || item.id === 'FD-SPECIAL') continue;
    const quantity = Number(item.quantity);
    if (!/^[A-Za-z0-9-]{1,40}$/.test(String(item.id)) ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: 'Invalid cart item or quantity.' });
    }
    requested.set(item.id, (requested.get(item.id) || 0) + quantity);
  }

  const lockId = 'LK-' + Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes

  if (requested.size === 0) return res.json({ lockId });

  if (db.isMongo) {
    const session = db.mongoClient.startSession();
    try {
      let conflicts = [];
      await session.withTransaction(async () => {
        const locks = db.mongoCollection('locks');
        const foodItems = db.mongoCollection('food_items');
        const now = Date.now();
        await locks.deleteMany({ expiryTime: { $lte: now } }, { session });
        const activeLocks = await locks.find(
          { expiryTime: { $gt: now } },
          { session }
        ).toArray();
        const lockTotals = new Map();
        activeLocks.forEach((lock) => {
          lockTotals.set(
            lock.foodItemId,
            (lockTotals.get(lock.foodItemId) || 0) + Number(lock.quantity || 0)
          );
        });
        const foods = await foodItems.find({
          id: { $in: [...requested.keys()] },
          listed: 1,
          stock: { $gt: 0 }
        }, { session }).toArray();
        const foodById = new Map(foods.map((food) => [food.id, food]));
        conflicts = [];
        requested.forEach((quantity, itemId) => {
          const food = foodById.get(itemId);
          const available = food
            ? Number(food.stock || 0) - (lockTotals.get(itemId) || 0)
            : 0;
          if (!food || quantity > available) {
            conflicts.push(`${itemId} (Only ${Math.max(0, available)} available)`);
          }
        });
        if (conflicts.length > 0) return;

        for (const itemId of requested.keys()) {
          const result = await foodItems.updateOne(
            { id: itemId, listed: 1, stock: { $gt: 0 } },
            { $inc: { reservationVersion: 1 } },
            { session }
          );
          if (result.matchedCount !== 1) {
            throw new Error('A food item changed while stock was being reserved.');
          }
        }
        await locks.insertMany([...requested.entries()].map(([foodItemId, quantity]) => ({
          id: lockId,
          foodItemId,
          quantity,
          expiryTime: expiry
        })), { session });
      });
      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'Some items are no longer available.',
          details: conflicts
        });
      }
      return res.json({ lockId });
    } catch (err) {
      console.error('MongoDB stock reservation failed:', err);
      return res.status(500).json({ error: 'Unable to reserve stock.' });
    } finally {
      await session.endSession();
    }
  }

  db.serialize(() => {
    db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
      if (beginErr) return res.status(500).json({ error: 'Unable to reserve stock.' });

      db.run("DELETE FROM locks WHERE expiryTime <= ?", [Date.now()], (cleanupErr) => {
        if (cleanupErr) {
          return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
        }

        db.all(
          `SELECT f.id, f.stock, COALESCE(SUM(l.quantity), 0) AS lockedQty
           FROM food_items f
           LEFT JOIN locks l ON l.foodItemId = f.id AND l.expiryTime > ?
           GROUP BY f.id`,
          [Date.now()],
          (stockErr, rows) => {
            if (stockErr) {
              return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
            }

            const conflicts = [];
            requested.forEach((quantity, itemId) => {
              const row = rows.find(item => item.id === itemId);
              const available = row ? Number(row.stock) - Number(row.lockedQty) : 0;
              if (!row || quantity > available) {
                conflicts.push(`${itemId} (Only ${Math.max(0, available)} available)`);
              }
            });
            if (conflicts.length > 0) {
              return db.run(
                "ROLLBACK",
                () => res.status(409).json({ error: 'Some items are no longer available.', details: conflicts })
              );
            }

            const stmt = db.prepare(
              "INSERT INTO locks (id, foodItemId, quantity, expiryTime) VALUES (?, ?, ?, ?)"
            );
            let insertError = null;
            requested.forEach((quantity, itemId) => {
              stmt.run([lockId, itemId, quantity, expiry], (err) => {
                if (err) insertError = err;
              });
            });
            stmt.finalize((finalizeErr) => {
              if (insertError || finalizeErr) {
                return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
              }
              db.run("COMMIT", (commitErr) => {
                if (commitErr) {
                  return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
                }
                res.json({ lockId });
              });
            });
          }
        );
      });
    });
  });
});

// Release Specific Lock
app.post('/api/locks/release', (req, res) => {
  const { lockId } = req.body;
  if (!lockId) return res.status(400).json({ error: 'Missing lock ID.' });

  db.run("DELETE FROM locks WHERE id = ?", [lockId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- API BOOKINGS & TRANSACTIONS ENDPOINTS ---

// Get All Bookings (Admin/Operator auth required)
app.get('/api/bookings', authenticateToken(['admin', 'operator']), (req, res) => {
  db.all("SELECT * FROM bookings ORDER BY bookingTime DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Parse items JSON strings
    const processed = rows.map(r => ({
      ...r,
      items: JSON.parse(r.items)
    }));
    res.json(processed);
  });
});

// Get Single Booking Status (Public)
app.get('/api/bookings/status/:id', (req, res) => {
  const bookingId = req.params.id;
  db.get("SELECT id, status, expiryTime, redeemedTime FROM bookings WHERE id = ?", [bookingId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Booking not found.' });
    res.json(row);
  });
});

// Retrieve bookings by checkout name or phone and pass key (4-digit PIN).
app.post('/api/bookings/retrieve', rateLimit(60 * 1000, 10, 'bill-retrieve'), (req, res) => {
  const { customerName, passkey } = req.body;
  const safeLookup = cleanText(customerName, 120);
  if (!safeLookup || typeof passkey !== 'string' || !/^\d{4}$/.test(passkey)) {
    return res.status(400).json({ error: 'Bill ID, checkout name, or phone and 4-digit pass key required.' });
  }

  const isBillIdLookup = /^NC-[A-Za-z0-9]{17}$/.test(safeLookup);
  let phoneLookup = safeLookup.replace(/[^\d]/g, '');
  const isPhoneLookup = /^[+()\d\s-]+$/.test(safeLookup) && validPhone(phoneLookup);
  if (isPhoneLookup && safeLookup.trim().startsWith('+') && phoneLookup.startsWith('91') && phoneLookup.length === 12) {
    phoneLookup = phoneLookup.slice(2);
  }
  const sql = isBillIdLookup
    ? "SELECT * FROM bookings WHERE id = ? AND status = 'pending' AND expiryTime > ? AND (passkeyLookup = ? OR passkeyLookup IS NULL)"
    : isPhoneLookup
      ? "SELECT * FROM bookings WHERE customerPhone = ? AND status = 'pending' AND (passkeyLookup = ? OR passkeyLookup IS NULL) AND expiryTime > ? ORDER BY bookingTime DESC"
      : "SELECT * FROM bookings WHERE LOWER(customerName) = ? AND status = 'pending' AND (passkeyLookup = ? OR passkeyLookup IS NULL) AND expiryTime > ? ORDER BY bookingTime DESC";
  const passkeyLookup = createBillPinLookup(passkey);
  const lookupValue = isBillIdLookup
    ? safeLookup
    : isPhoneLookup
      ? phoneLookup
      : safeLookup.toLowerCase();
  const currentTime = new Date().toISOString();

  const returnMatches = async rows => {
    try {
      const indexedMatches = rows.filter(row => row.passkeyLookup === passkeyLookup);
      const legacyCandidates = rows.filter(row => !row.passkeyLookup && typeof row.passkey === 'string');
      const verification = await verifyPasskeys(passkey, legacyCandidates.map(row => row.passkey));
      if (verification.invalidCount > 0) {
        console.warn(`Skipped ${verification.invalidCount} bill(s) with an invalid stored pass key.`);
      }
      const legacyMatches = verification.matchingIndexes.map(index => legacyCandidates[index]);
      const matches = indexedMatches.concat(legacyMatches);
      await Promise.all(legacyMatches.map(row => new Promise(resolve => {
        db.run(
          'UPDATE bookings SET passkeyLookup = ? WHERE id = ?',
          [passkeyLookup, row.id],
          error => {
            if (error) {
              console.warn(`Could not index PIN lookup for bill ${row.id}:`, error);
            }
            resolve();
          }
        );
      })));
      const processed = matches.map(row => {
        let items = row.items;
        if (typeof items === 'string') {
          try {
            items = JSON.parse(items);
          } catch (error) {
            console.warn('Bill items could not be parsed.');
            items = [];
          }
        }
        return {
          ...row,
          items: Array.isArray(items) ? items : [],
          passkey: undefined,
          passkeyLookup: undefined
        };
      });
      if (processed.length === 0) return res.status(404).json({ error: 'No pending bills found for this checkout name or phone and pass key.' });
      res.json(processed);
    } catch (error) {
      console.error('Failed to retrieve customer bills:', error);
      if (!res.headersSent) {
        const statusCode = error.statusCode || 500;
        const message = error.statusCode
          ? error.message
          : 'Unable to search bills right now. Please try again.';
        res.status(statusCode).json({ error: message });
      }
    }
  };

  if (db.isMongo) {
    const filter = {
      status: 'pending',
      expiryTime: { $gt: currentTime },
      $or: [{ passkeyLookup }, { passkeyLookup: null }]
    };
    if (isBillIdLookup) {
      filter.id = safeLookup;
    } else if (isPhoneLookup) {
      filter.customerPhone = phoneLookup;
    } else {
      filter.customerName = safeLookup;
    }
    const query = db.mongoCollection('bookings').find(filter);
    if (!isBillIdLookup && !isPhoneLookup) {
      query.collation({ locale: 'en', strength: 2 });
    }
    if (!isBillIdLookup) {
      query.sort({ bookingTime: -1 });
    }
    query.toArray()
      .then(rows => returnMatches(rows.map(row => db.normalizeRow(row))))
      .catch(error => {
        console.error('Failed to query customer bills:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Unable to search bills right now. Please try again.' });
        }
      });
    return;
  }

  const params = isBillIdLookup
    ? [lookupValue, currentTime, passkeyLookup]
    : [lookupValue, passkeyLookup, currentTime];
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to query customer bills:', err);
      return res.status(500).json({ error: 'Unable to search bills right now. Please try again.' });
    }
    returnMatches(rows);
  });
});

// Cancel a pending ticket (admin only; payment and ledger records are not altered).
app.post('/api/bookings/:id/cancel', authenticateToken(['admin']), (req, res) => {
  const bookingId = String(req.params.id || '').trim();
  if (!bookingId || bookingId.length > 64) {
    return res.status(400).json({ error: 'A valid ticket ID is required.' });
  }

  db.get('SELECT id, status, expiryTime FROM bookings WHERE id = ?', [bookingId], (err, booking) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!booking) return res.status(404).json({ error: 'Bill not found.' });
    if (booking.status !== 'pending') {
      return res.status(409).json({ error: `Only pending tickets can be cancelled. Current status: ${booking.status}.` });
    }

    if (new Date(booking.expiryTime).getTime() <= Date.now()) {
      db.run("UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'pending'", [bookingId], updateErr => {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        return res.status(409).json({ error: 'This ticket has expired and cannot be cancelled.' });
      });
      return;
    }

    db.run("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [bookingId], updateErr => {
      if (updateErr) return res.status(500).json({ error: updateErr.message });
      db.get('SELECT status FROM bookings WHERE id = ?', [bookingId], (checkErr, updatedBooking) => {
        if (checkErr) return res.status(500).json({ error: checkErr.message });
        if (!updatedBooking) return res.status(404).json({ error: 'Bill not found.' });
        if (updatedBooking.status !== 'cancelled') {
          return res.status(409).json({ error: `Ticket could not be cancelled. Current status: ${updatedBooking.status}.` });
        }
        res.json({ success: true, id: bookingId, status: 'cancelled' });
      });
    });
  });
});

// Delete a bill record (admin only; retain its accounting ledger entry).
app.delete('/api/bookings/:id', authenticateToken(['admin']), (req, res) => {
  const bookingId = String(req.params.id || '').trim();
  if (!bookingId || bookingId.length > 64) {
    return res.status(400).json({ error: 'A valid ticket ID is required.' });
  }

  db.get('SELECT id FROM bookings WHERE id = ?', [bookingId], (err, booking) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!booking) return res.status(404).json({ error: 'Bill not found.' });
    db.run('DELETE FROM bookings WHERE id = ?', [bookingId], deleteErr => {
      if (deleteErr) return res.status(500).json({ error: deleteErr.message });
      res.json({ success: true, id: bookingId });
    });
  });
});

// --- API RAZORPAY PAYMENT ENDPOINTS ---

// Get Razorpay Configuration (Public)
app.get('/api/payments/config', (req, res) => {
  db.get("SELECT value FROM settings WHERE key = 'razorpay_key_id'", (err, row) => {
    if (err) {
      console.error('Failed to load Razorpay configuration:', err);
      return res.status(500).json({ error: 'Unable to load payment configuration.' });
    }
    const keyId = row ? row.value : process.env.RAZORPAY_KEY_ID;
    if (keyId && keyId.trim() !== '') {
      res.json({ enabled: true, keyId: keyId.trim() });
    } else {
      res.json({ enabled: false });
    }
  });
});

// Save Razorpay API Keys (Admin only)
app.post('/api/settings/razorpay', authenticateToken(['admin']), (req, res) => {
  const { keyId, keySecret } = req.body;
  if (typeof keyId !== 'string' || typeof keySecret !== 'string' ||
      !keyId.trim() || !keySecret.trim()) {
    return res.status(400).json({ error: 'Both Key ID and Key Secret are required.' });
  }

  db.run(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('razorpay_key_id', ?)",
    [keyId.trim()],
    (keyIdErr) => {
      if (keyIdErr) {
        console.error('Failed to save Razorpay Key ID:', keyIdErr);
        return res.status(500).json({ error: 'Failed to save Razorpay Key ID.' });
      }
      db.run(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('razorpay_key_secret', ?)",
        [keySecret.trim()],
        (secretErr) => {
          if (secretErr) {
            console.error('Failed to save Razorpay Key Secret:', secretErr);
            return res.status(500).json({ error: 'Failed to save Razorpay Key Secret.' });
          }
          res.json({ success: true, message: 'Razorpay API credentials updated successfully.' });
        }
      );
    }
  );
});

// Create Razorpay Order
app.post('/api/payments/create-order', (req, res) => {
  const { amount, bookingData } = req.body;
  if (!amount || amount <= 0 || !bookingData || typeof bookingData !== 'object') {
    return res.status(400).json({ error: 'Invalid checkout amount or booking data.' });
  }

  // Fetch Razorpay credentials from db or environment
  db.all("SELECT * FROM food_items WHERE listed = 1 AND stock > 0", (catalogErr, catalog) => {
    if (catalogErr) return res.status(500).json({ error: 'Unable to validate menu items.' });
    getActiveSpecialOfferCatalogEntry((offerErr, specialOffer) => {
    if (offerErr) return res.status(500).json({ error: 'Unable to validate special offer.' });
    if (specialOffer) catalog.push(specialOffer);
    const safeName = cleanText(bookingData.customerName, 120);
    const safePhone = cleanText(bookingData.customerPhone, 15);
    const normalizedItems = normalizeBookingItems(bookingData.items, catalog);
    const serverTotal = normalizedItems &&
      normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    if (!bookingData.id || !/^[A-Za-z0-9-]{10,40}$/.test(bookingData.id) ||
        !safeName || !validPhone(safePhone) || typeof bookingData.passkey !== 'string' ||
        !/^\d{4}$/.test(bookingData.passkey) || !normalizedItems ||
        !Number.isFinite(serverTotal) || Math.abs(serverTotal - Number(amount)) > 0.01) {
      return res.status(400).json({ error: 'Invalid or stale checkout data.' });
    }

    db.get("SELECT value FROM settings WHERE key = 'razorpay_key_id'", (err, rId) => {
      db.get("SELECT value FROM settings WHERE key = 'razorpay_key_secret'", (err, rSecret) => {
      const keyId = (rId ? rId.value : process.env.RAZORPAY_KEY_ID) || '';
      const keySecret = (rSecret ? rSecret.value : process.env.RAZORPAY_KEY_SECRET) || '';

      if (!keyId.trim() || !keySecret.trim()) {
        return res.status(500).json({ error: 'Razorpay credentials not configured on server.' });
      }

      try {
        const Razorpay = require('razorpay');
        const razorpay = new Razorpay({
          key_id: keyId.trim(),
          key_secret: keySecret.trim()
        });

        const options = {
          amount: Math.round(amount * 100), // in paise
          currency: "INR",
          receipt: "rzp_rec_" + Math.floor(100000 + Math.random() * 900000).toString()
        };

        razorpay.orders.create(options, (err, order) => {
          if (err) {
            console.error("Razorpay order creation error:", err);
            return res.status(500).json({ error: err.message || 'Razorpay order creation failed.' });
          }
          paymentIntents.set(order.id, {
            id: bookingData.id,
            customerName: safeName,
            customerPhone: safePhone,
            passkey: bookingData.passkey,
            items: normalizedItems,
            totalAmount: serverTotal,
            lockId: bookingData.lockId
          });
          res.json(order);
        });
      } catch (e) {
        console.error("Razorpay SDK initialize failed:", e);
        res.status(500).json({ error: 'Failed to initialize payment gateway.' });
      }
      });
    });
    });
  });
});

// Verify signature and finalize order
app.post('/api/payments/verify-signature', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment signature verification parameters.' });
  }
  const bookingData = paymentIntents.get(razorpay_order_id);
  if (!bookingData) return res.status(400).json({ error: 'Payment intent is missing or already used.' });

  db.get("SELECT value FROM settings WHERE key = 'razorpay_key_secret'", (err, rSecret) => {
    const keySecret = (rSecret ? rSecret.value : process.env.RAZORPAY_KEY_SECRET) || '';

    if (!keySecret.trim()) {
      return res.status(500).json({ error: 'Payment gateway configuration missing.' });
    }

    try {
      const crypto = require('crypto');
      const text = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', keySecret.trim())
        .update(text)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Cryptographic signature verification failed.' });
      }

      paymentIntents.delete(razorpay_order_id);

      // Check stock & finalize booking
      const { id, customerName, customerPhone, passkey, items, totalAmount, lockId } = bookingData;

      db.all("SELECT * FROM food_items WHERE listed = 1 AND stock > 0", (err, catalog) => {
        if (err) return res.status(500).json({ error: err.message });

        let stockIssues = [];
        items.forEach(cItem => {
          if (cItem.foodItemId === 'FD-SPECIAL') return;
          const food = catalog.find(f => f.id === cItem.foodItemId);
          if (!food || food.stock < cItem.quantity) {
            stockIssues.push(`${cItem.name} (Only ${food ? food.stock : 0} available)`);
          }
        });

        if (stockIssues.length > 0) {
          return res.status(409).json({ error: 'Stock deficit detected.', details: stockIssues });
        }

        db.get("SELECT value FROM settings WHERE key = 'account_details'", (err, settingsRow) => {
          let ticketHours = 5;
          if (!err && settingsRow) {
            try {
              const config = JSON.parse(settingsRow.value);
              if (config.ticketExpiryHours) {
                ticketHours = parseFloat(config.ticketExpiryHours);
              }
            } catch (e) {}
          }

          const bookingTime = new Date().toISOString();
          const expiryTime = new Date(Date.now() + ticketHours * 3600 * 1000).toISOString();

          db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            const updateStmt = db.prepare("UPDATE food_items SET stock = stock - ?, listed = CASE WHEN stock - ? <= 0 THEN 0 ELSE listed END WHERE id = ?");
            items.forEach(item => {
              if (item.foodItemId !== 'FD-SPECIAL') {
                updateStmt.run([item.quantity, item.quantity, item.foodItemId]);
              }
            });
            updateStmt.finalize();

            db.run(
              "INSERT INTO bookings (id, customerName, customerPhone, passkey, passkeyLookup, items, totalAmount, paymentMethod, paymentStatus, bookingTime, expiryTime, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [id, customerName, customerPhone, bcrypt.hashSync(passkey, 12), createBillPinLookup(passkey), JSON.stringify(items), totalAmount, 'Razorpay (Online)', 'Paid', bookingTime, expiryTime, 'pending']
            );

            const txId = 'TX-' + Math.floor(20000 + Math.random() * 80000).toString();
            db.run(
              "INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)",
              [txId, 'sale', `Online Order - ${customerName}`, totalAmount, bookingTime, items.map(i => `${i.name} x${i.quantity}`).join(', ')]
            );

            if (lockId) {
              db.run("DELETE FROM locks WHERE id = ?", [lockId]);
            }

            db.run("COMMIT", (commitErr) => {
              if (commitErr) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: 'Failed to record online booking.' });
              }
              res.json({ success: true, bookingId: id });
            });
          });
        });
      });
    } catch (e) {
      console.error("Signature verify failed with crash:", e);
      res.status(500).json({ error: 'Cryptographic signature verification crash.' });
    }
  });
});

// Place Booking (Checkout Checkout Order)
app.post('/api/bookings', rateLimit(60 * 1000, 20, 'booking-create'), (req, res) => {
  const { id, customerName, customerPhone, passkey, items, totalAmount, paymentMethod, lockId } = req.body;

  const safeName = cleanText(customerName, 120);
  const safePhone = cleanText(customerPhone, 15);
  if (!id || !/^[A-Za-z0-9-]{10,40}$/.test(id) || !safeName ||
      !validPhone(safePhone) || typeof passkey !== 'string' || !/^\d{4}$/.test(passkey)) {
    return res.status(400).json({ error: 'Invalid booking data.' });
  }

  // 1. Double check current catalog stock
  db.all("SELECT * FROM food_items WHERE listed = 1 AND stock > 0", (err, catalog) => {
    if (err) return res.status(500).json({ error: err.message });

    const normalizedItems = normalizeBookingItems(items, catalog);
    if (!normalizedItems) return res.status(400).json({ error: 'Invalid order items.' });
    let stockIssues = [];
    normalizedItems.forEach(cItem => {
      const food = catalog.find(f => f.id === cItem.foodItemId);
      if (!food || food.stock < cItem.quantity) {
        stockIssues.push(`${cItem.name} (Only ${food ? food.stock : 0} available)`);
      }
    });

    if (stockIssues.length > 0) {
      return res.status(409).json({ error: 'Stock deficit detected.', details: stockIssues });
    }

    db.get("SELECT value FROM settings WHERE key = 'account_details'", (err, settingsRow) => {
      let ticketHours = 5;
      if (!err && settingsRow) {
        try {
          const config = JSON.parse(settingsRow.value);
          if (config.ticketExpiryHours) {
            ticketHours = parseFloat(config.ticketExpiryHours);
          }
        } catch (e) {}
      }

      const serverTotal = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      if (!Number.isFinite(serverTotal) || Math.abs(serverTotal - Number(totalAmount)) > 0.01) {
        return res.status(400).json({ error: 'Order total does not match the current menu.' });
      }
      const hashedPasskey = bcrypt.hashSync(passkey, 12);
      // 2. Perform booking insertion and stock reduction
      const bookingTime = new Date().toISOString();
      const expiryTime = new Date(Date.now() + ticketHours * 3600 * 1000).toISOString();

      db.serialize(() => {
        // Begin transaction manually in serialize
        db.run("BEGIN TRANSACTION");

        // Reduce item stock levels
        const updateStmt = db.prepare("UPDATE food_items SET stock = stock - ?, listed = CASE WHEN stock - ? <= 0 THEN 0 ELSE listed END WHERE id = ?");
        normalizedItems.forEach(item => {
          updateStmt.run([item.quantity, item.quantity, item.foodItemId]);
        });
        updateStmt.finalize();

        // Insert booking record
        db.run(
          "INSERT INTO bookings (id, customerName, customerPhone, passkey, passkeyLookup, items, totalAmount, paymentMethod, paymentStatus, bookingTime, expiryTime, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, safeName, safePhone, hashedPasskey, createBillPinLookup(passkey), JSON.stringify(normalizedItems), serverTotal, 'UPI', 'Paid', bookingTime, expiryTime, 'pending']
        );

        // Create cashier ledger transaction logs
        const txId = 'TX-' + Math.floor(20000 + Math.random() * 80000).toString();
        const txTitle = `Order Placed - ${safeName}`;
        const txDetails = normalizedItems.map(i => `${i.name} x${i.quantity}`).join(', ');
        db.run(
          "INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)",
          [txId, 'sale', txTitle, serverTotal, bookingTime, txDetails]
        );

        // Release the temporary lock
        if (lockId) {
          db.run("DELETE FROM locks WHERE id = ?", [lockId]);
        }

        db.run("COMMIT", (commitErr) => {
          if (commitErr) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: 'Failed to place booking transaction.' });
          }
          res.json({ success: true, bookingId: id });
        });
      });
    });
  });
});

// Redeem Booking (Admin/Operator required)
app.post('/api/bookings/redeem', authenticateToken(['admin', 'operator']), (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Booking token ID is required.' });

  db.get("SELECT * FROM bookings WHERE id = ?", [id], (err, booking) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!booking) {
      return res.status(404).json({ error: 'Ticket ID not found in database.' });
    }

    if (booking.status === 'redeemed') {
      return res.status(409).json({ error: 'Ticket already redeemed.', redeemedTime: booking.redeemedTime });
    }
    if (booking.status === 'cancelled') {
      return res.status(410).json({ error: 'Ticket cancelled by an administrator.', status: 'cancelled' });
    }

    // Expiry check
    const expiry = new Date(booking.expiryTime);
    if (Date.now() > expiry.getTime()) {
      db.run("UPDATE bookings SET status = 'expired' WHERE id = ?", [id]);
      return res.status(410).json({ error: 'Ticket expired.' });
    }

    const redeemedTime = new Date().toISOString();
    db.run(
      "UPDATE bookings SET status = 'redeemed', redeemedTime = ? WHERE id = ?",
      [redeemedTime, id],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        
        // Return booking details parsed
        res.json({
          success: true,
          booking: {
            ...booking,
            items: JSON.parse(booking.items),
            status: 'redeemed',
            redeemedTime
          }
        });
      }
    );
  });
});

// --- API LEDGER ENDPOINTS ---

// Get Ledger logs (Admin/Operator required)
app.get('/api/ledger', authenticateToken(['admin', 'operator']), (req, res) => {
  db.all("SELECT * FROM transactions ORDER BY timestamp DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add Custom transaction (Admin required)
app.post('/api/ledger', authenticateToken(['admin']), (req, res) => {
  const { type, title, amount, details } = req.body;
  if (!type || !title || amount == null) {
    return res.status(400).json({ error: 'Invalid transaction parameters.' });
  }

  const txId = 'TX-' + Math.floor(20000 + Math.random() * 80000).toString();
  const timestamp = new Date().toISOString();

  db.run(
    "INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)",
    [txId, type, title, amount, timestamp, details || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: txId });
    }
  );
});

// Edit Transaction (Admin required)
app.put('/api/ledger/:id', authenticateToken(['admin']), (req, res) => {
  const { amount, details } = req.body;
  const txId = req.params.id;

  db.run(
    "UPDATE transactions SET amount = ?, details = ? WHERE id = ?",
    [amount, details, txId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Delete Transaction (Admin required)
app.delete('/api/ledger/:id', authenticateToken(['admin']), (req, res) => {
  const txId = req.params.id;
  db.run("DELETE FROM transactions WHERE id = ?", [txId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- API BACKUP / EXPORT / IMPORT ENDPOINTS ---

// Export entire database state as JSON string (Admin required)
app.get('/api/backup/export', authenticateToken(['admin']), (req, res) => {
  const backup = {};
  db.all("SELECT * FROM food_items", (err, foods) => {
    backup.foodItems = foods || [];
    db.all("SELECT * FROM bookings", (err, bookings) => {
      backup.bookings = (bookings || []).map(b => ({ ...b, items: JSON.parse(b.items) }));
      db.all("SELECT * FROM ingredients", (err, ings) => {
        backup.ingredients = ings || [];
        db.all("SELECT * FROM transactions", (err, txs) => {
          backup.transactions = txs || [];
          db.all("SELECT * FROM settings", (err, settings) => {
            // Find settings values
            const settingsObj = {};
            settings.forEach(s => {
              settingsObj[s.key] = s.value;
            });
            backup.settings = settingsObj;
            res.json(backup);
          });
        });
      });
    });
  });
});

// Restore database from uploaded JSON object (Admin required)
app.post('/api/backup/restore', authenticateToken(['admin']), (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: 'Missing backup payload.' });

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    
    // Clear and refill food items
    if (data.foodItems) {
      db.run("DELETE FROM food_items");
      const stmt = db.prepare("INSERT INTO food_items (id, name, price, stock, category, isveg, image, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      data.foodItems.forEach(f => {
        stmt.run([f.id, f.name, f.price, f.stock, f.category, f.isveg, f.image, f.details || '']);
      });
      stmt.finalize();
    }

    // Clear and refill bookings
    if (data.bookings) {
      db.run("DELETE FROM bookings");
      const stmt = db.prepare("INSERT INTO bookings (id, customerName, customerPhone, passkey, passkeyLookup, items, totalAmount, paymentMethod, paymentStatus, bookingTime, expiryTime, status, redeemedTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      data.bookings.forEach(b => {
        stmt.run([b.id, b.customerName, b.customerPhone, b.passkey, b.passkeyLookup || null, JSON.stringify(b.items), b.totalAmount, b.paymentMethod, b.paymentStatus, b.bookingTime, b.expiryTime, b.status, b.redeemedTime || null]);
      });
      stmt.finalize();
    }

    // Clear and refill ingredients
    if (data.ingredients) {
      db.run("DELETE FROM ingredients");
      const stmt = db.prepare("INSERT INTO ingredients (id, name, stock, unit, lastPurchaseDate) VALUES (?, ?, ?, ?, ?)");
      data.ingredients.forEach(i => {
        stmt.run([i.id, i.name, i.stock, i.unit, i.lastPurchaseDate || null]);
      });
      stmt.finalize();
    }

    // Clear and refill transactions
    if (data.transactions) {
      db.run("DELETE FROM transactions");
      const stmt = db.prepare("INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)");
      data.transactions.forEach(t => {
        stmt.run([t.id, t.type, t.title, t.amount, t.timestamp, t.details || '']);
      });
      stmt.finalize();
    }

    // Refill settings credentials
    if (data.settings) {
      Object.keys(data.settings).forEach(key => {
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, data.settings[key]]);
      });
    }

    db.run("COMMIT", (err) => {
      if (err) {
        db.run("ROLLBACK");
        return res.status(500).json({ error: 'Restore database failed.' });
      }
      res.json({ success: true, message: 'Database successfully restored.' });
    });
  });
});

// Launch Server Listening
app.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(`🚀 N Cafe Production Server launched at: http://localhost:${PORT}`);
  console.log(`🔒 Secure SSL/HTTPS and API endpoints fully operational.`);
  console.log(`========================================================`);
});

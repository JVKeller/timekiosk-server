import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import helmet from 'helmet';
import fs from 'fs';
import https from 'https';
import pg from 'pg';

const { Pool } = pg;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3333;
const HOST = process.env.HOST || '0.0.0.0';

// TLS configuration
const enableTLS = process.env.ENABLE_TLS === 'true';
const tlsCertPath = process.env.TLS_CERT || './certs/cert.pem';
const tlsKeyPath = process.env.TLS_KEY || './certs/key.pem';

let httpsOptions = {};
if (enableTLS) {
    try {
        if (fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath)) {
            httpsOptions = {
                cert: fs.readFileSync(tlsCertPath),
                key: fs.readFileSync(tlsKeyPath),
            };
            console.log('TLS certificates loaded successfully.');
        } else {
            console.warn("TLS certificates not found. Falling back to HTTP mode.");
        }
    } catch (error) {
        console.error(`Error loading TLS certificates:`, error.message);
    }
} else {
    console.log('TLS disabled (ENABLE_TLS=false). Running in HTTP mode - use a reverse proxy for HTTPS.');
}

// CORS configuration from environment
const corsOrigin = process.env.CORS_ORIGIN || '*';
const parsedOrigins = corsOrigin === '*' ? true : corsOrigin.split(',').map(o => o.trim());

// Middleware
app.use(cors({
    origin: parsedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(helmet());

// PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Initialize database tables
async function initDB() {
    const client = await pool.connect();
    try {
        // Create tables if they don't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id VARCHAR(100) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                pin VARCHAR(50) NOT NULL,
                image_url TEXT,
                archived BOOLEAN DEFAULT false,
                auto_deduct_lunch BOOLEAN DEFAULT false,
                location_id VARCHAR(100),
                department_id VARCHAR(100),
                is_temp BOOLEAN DEFAULT false,
                temp_agency VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS timerecords (
                id VARCHAR(100) PRIMARY KEY,
                employee_id VARCHAR(100) NOT NULL,
                location_id VARCHAR(100),
                clock_in TIMESTAMP NOT NULL,
                clock_out TIMESTAMP,
                breaks JSONB DEFAULT '[]',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS locations (
                id VARCHAR(100) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                abbreviation VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS departments (
                id VARCHAR(100) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS settings (
                id VARCHAR(100) PRIMARY KEY,
                logo_url TEXT,
                week_start_day INTEGER DEFAULT 0,
                remote_db_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Check if we need to seed initial data
        const empCheck = await client.query('SELECT COUNT(*) FROM employees');
        if (parseInt(empCheck.rows[0].count) === 0) {
            console.log('Seeding initial data...');

            await client.query(`
                INSERT INTO employees (id, name, pin, archived) VALUES
                ('EMP001', 'Alice Johnson', '1234', false),
                ('EMP002', 'Bob Smith', '5678', false),
                ('EMP003', 'Charlie Brown', '1111', false)
                ON CONFLICT (id) DO NOTHING;
            `);

            await client.query(`
                INSERT INTO locations (id, name, abbreviation) VALUES
                ('LOC001', 'Main Office', 'MO'),
                ('LOC002', 'Warehouse', 'WH')
                ON CONFLICT (id) DO NOTHING;
            `);

            await client.query(`
                INSERT INTO departments (id, name) VALUES
                ('DEP001', 'Engineering'),
                ('DEP002', 'Operations')
                ON CONFLICT (id) DO NOTHING;
            `);

            await client.query(`
                INSERT INTO settings (id, week_start_day, logo_url, remote_db_url) VALUES
                ('GLOBAL_SETTINGS', 0, '', '')
                ON CONFLICT (id) DO NOTHING;
            `);

            console.log('Initial data seeded!');
        }

        console.log('PostgreSQL Database Initialized');
    } catch (err) {
        console.error('Database initialization error:', err);
        throw err;
    } finally {
        client.release();
    }
}

// Helper: Convert DB row to API format (snake_case to camelCase)
function dbToApi(row, collection) {
    if (!row) return null;

    if (collection === 'employees') {
        return {
            id: row.id,
            name: row.name,
            pin: row.pin,
            imageUrl: row.image_url,
            archived: row.archived,
            autoDeductLunch: row.auto_deduct_lunch,
            locationId: row.location_id,
            departmentId: row.department_id,
            isTemp: row.is_temp,
            tempAgency: row.temp_agency
        };
    }
    if (collection === 'timerecords') {
        return {
            id: row.id,
            employeeId: row.employee_id,
            locationId: row.location_id,
            clockIn: row.clock_in,
            clockOut: row.clock_out,
            breaks: row.breaks || []
        };
    }
    if (collection === 'locations') {
        return {
            id: row.id,
            name: row.name,
            abbreviation: row.abbreviation
        };
    }
    if (collection === 'departments') {
        return {
            id: row.id,
            name: row.name
        };
    }
    if (collection === 'settings') {
        return {
            id: row.id,
            logoUrl: row.logo_url,
            weekStartDay: row.week_start_day,
            remoteDbUrl: row.remote_db_url
        };
    }
    return row;
}

// Authentication Middleware
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    const expectedToken = process.env.SYNC_TOKEN;

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    if (expectedToken && token !== expectedToken) {
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }

    next();
};

// Valid collections
const validCollections = ['employees', 'timerecords', 'locations', 'departments', 'settings'];

// Health check (no auth required)
app.get('/', (req, res) => {
    res.json({ status: 'TimeKiosk Sync Server Running (PostgreSQL)' });
});

// GET All
app.get('/:collection', authMiddleware, async (req, res) => {
    const { collection } = req.params;
    if (!validCollections.includes(collection)) {
        return res.status(404).json({ error: 'Collection not found' });
    }

    try {
        const result = await pool.query(`SELECT * FROM ${collection}`);
        res.json(result.rows.map(row => dbToApi(row, collection)));
    } catch (err) {
        console.error('GET all error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET One
app.get('/:collection/:id', authMiddleware, async (req, res) => {
    const { collection, id } = req.params;
    if (!validCollections.includes(collection)) {
        return res.status(404).json({ error: 'Collection not found' });
    }

    try {
        const result = await pool.query(`SELECT * FROM ${collection} WHERE id = $1`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }
        res.json(dbToApi(result.rows[0], collection));
    } catch (err) {
        console.error('GET one error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST (Create)
app.post('/:collection', authMiddleware, async (req, res) => {
    const { collection } = req.params;
    if (!validCollections.includes(collection)) {
        return res.status(404).json({ error: 'Collection not found' });
    }

    const data = req.body;

    try {
        let query, values;

        if (collection === 'employees') {
            query = `INSERT INTO employees (id, name, pin, image_url, archived, auto_deduct_lunch, location_id, department_id, is_temp, temp_agency)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`;
            values = [data.id, data.name, data.pin, data.imageUrl, data.archived || false, data.autoDeductLunch || false,
            data.locationId, data.departmentId, data.isTemp || false, data.tempAgency];
        } else if (collection === 'timerecords') {
            query = `INSERT INTO timerecords (id, employee_id, location_id, clock_in, clock_out, breaks)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
            values = [data.id, data.employeeId, data.locationId, data.clockIn, data.clockOut, JSON.stringify(data.breaks || [])];
        } else if (collection === 'locations') {
            query = `INSERT INTO locations (id, name, abbreviation) VALUES ($1, $2, $3) RETURNING *`;
            values = [data.id, data.name, data.abbreviation];
        } else if (collection === 'departments') {
            query = `INSERT INTO departments (id, name) VALUES ($1, $2) RETURNING *`;
            values = [data.id, data.name];
        } else if (collection === 'settings') {
            query = `INSERT INTO settings (id, logo_url, week_start_day, remote_db_url) VALUES ($1, $2, $3, $4) RETURNING *`;
            values = [data.id, data.logoUrl, data.weekStartDay, data.remoteDbUrl];
        }

        const result = await pool.query(query, values);
        res.status(201).json(dbToApi(result.rows[0], collection));
    } catch (err) {
        console.error('POST error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT (Update/Upsert)
app.put('/:collection/:id', authMiddleware, async (req, res) => {
    const { collection, id } = req.params;
    if (!validCollections.includes(collection)) {
        return res.status(404).json({ error: 'Collection not found' });
    }

    const data = req.body;

    try {
        let query, values;

        if (collection === 'employees') {
            query = `INSERT INTO employees (id, name, pin, image_url, archived, auto_deduct_lunch, location_id, department_id, is_temp, temp_agency)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     ON CONFLICT (id) DO UPDATE SET
                     name = EXCLUDED.name, pin = EXCLUDED.pin, image_url = EXCLUDED.image_url, archived = EXCLUDED.archived,
                     auto_deduct_lunch = EXCLUDED.auto_deduct_lunch, location_id = EXCLUDED.location_id, department_id = EXCLUDED.department_id,
                     is_temp = EXCLUDED.is_temp, temp_agency = EXCLUDED.temp_agency, updated_at = CURRENT_TIMESTAMP
                     RETURNING *`;
            values = [data.id || id, data.name, data.pin, data.imageUrl, data.archived || false, data.autoDeductLunch || false,
            data.locationId, data.departmentId, data.isTemp || false, data.tempAgency];
        } else if (collection === 'timerecords') {
            query = `INSERT INTO timerecords (id, employee_id, location_id, clock_in, clock_out, breaks)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (id) DO UPDATE SET
                     employee_id = EXCLUDED.employee_id, location_id = EXCLUDED.location_id, clock_in = EXCLUDED.clock_in,
                     clock_out = EXCLUDED.clock_out, breaks = EXCLUDED.breaks, updated_at = CURRENT_TIMESTAMP
                     RETURNING *`;
            values = [data.id || id, data.employeeId, data.locationId, data.clockIn, data.clockOut, JSON.stringify(data.breaks || [])];
        } else if (collection === 'locations') {
            query = `INSERT INTO locations (id, name, abbreviation) VALUES ($1, $2, $3)
                     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, abbreviation = EXCLUDED.abbreviation
                     RETURNING *`;
            values = [data.id || id, data.name, data.abbreviation];
        } else if (collection === 'departments') {
            query = `INSERT INTO departments (id, name) VALUES ($1, $2)
                     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
                     RETURNING *`;
            values = [data.id || id, data.name];
        } else if (collection === 'settings') {
            query = `INSERT INTO settings (id, logo_url, week_start_day, remote_db_url) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (id) DO UPDATE SET logo_url = EXCLUDED.logo_url, week_start_day = EXCLUDED.week_start_day,
                     remote_db_url = EXCLUDED.remote_db_url, updated_at = CURRENT_TIMESTAMP
                     RETURNING *`;
            values = [data.id || id, data.logoUrl, data.weekStartDay, data.remoteDbUrl];
        }

        const result = await pool.query(query, values);
        res.json(dbToApi(result.rows[0], collection));
    } catch (err) {
        console.error('PUT error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE
app.delete('/:collection/:id', authMiddleware, async (req, res) => {
    const { collection, id } = req.params;
    if (!validCollections.includes(collection)) {
        return res.status(404).json({ error: 'Collection not found' });
    }

    try {
        const result = await pool.query(`DELETE FROM ${collection} WHERE id = $1 RETURNING *`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Initialize DB and start server
initDB().then(() => {
    if (enableTLS && httpsOptions.cert) {
        https.createServer(httpsOptions, app).listen(PORT, HOST, () => {
            console.log(`HTTPS Server running on https://${HOST}:${PORT}`);
        });
    } else {
        app.listen(PORT, HOST, () => {
            console.log(`HTTP Server running on http://${HOST}:${PORT}`);
        });
    }
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});

export default app;

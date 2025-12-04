import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import helmet from 'helmet';
import fs from 'fs';
import https from 'https';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3333;

// TLS certificates
const tlsCertPath = process.env.TLS_CERT || './certs/cert.pem';
const tlsKeyPath = process.env.TLS_KEY || './certs/key.pem';

let httpsOptions = {};
try {
    if (fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath)) {
        httpsOptions = {
            cert: fs.readFileSync(tlsCertPath),
            key: fs.readFileSync(tlsKeyPath),
        };
    } else {
        console.warn("TLS certificates not found. Running in HTTP mode (not secure for production).");
    }
} catch (error) {
    console.error(`Error loading TLS certificates:`, error.message);
}

// Middleware
app.use(cors({
    origin: true, // Allow any origin
    credentials: true, // Allow cookies/headers
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(helmet());

// Database Schemas (Matching Client)
const schemas = {
    employee: {
        title: 'employee',
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 100 },
            name: { type: 'string' },
            pin: { type: 'string' },
            imageUrl: { type: 'string' },
            archived: { type: 'boolean' },
            autoDeductLunch: { type: 'boolean' },
            locationId: { type: 'string' },
            departmentId: { type: 'string' },
            isTemp: { type: 'boolean' },
            tempAgency: { type: 'string' }
        },
        required: ['id', 'name', 'pin']
    },
    time_record: {
        title: 'time_record',
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 100 },
            employeeId: { type: 'string', maxLength: 100 },
            locationId: { type: 'string' },
            clockIn: { type: 'string', format: 'date-time' },
            clockOut: { type: 'string', format: 'date-time' },
            breaks: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        start: { type: 'string', format: 'date-time' },
                        end: { type: 'string', format: 'date-time' }
                    }
                }
            }
        },
        required: ['id', 'employeeId', 'clockIn'],
        indexes: ['employeeId']
    },
    location: {
        title: 'location',
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 100 },
            name: { type: 'string' },
            abbreviation: { type: 'string' }
        },
        required: ['id', 'name']
    },
    department: {
        title: 'department',
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 100 },
            name: { type: 'string' }
        },
        required: ['id', 'name']
    },
    settings: {
        title: 'settings',
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 100 },
            logoUrl: { type: 'string' },
            weekStartDay: { type: 'number' },
            remoteDbUrl: { type: 'string' }
        },
        required: ['id']
    }
};

let db;

async function initDB() {
    // Using Memory storage for now to ensure compatibility. 
    // In production, switch this to a persistent storage adapter (e.g. FoundationDB, MongoDB, or filesystem)
    db = await createRxDatabase({
        name: 'timekiosk_server_db',
        storage: getRxStorageMemory()
    });

    await db.addCollections({
        employees: { schema: schemas.employee },
        timerecords: { schema: schemas.time_record }, // Corrected name
        locations: { schema: schemas.location },
        departments: { schema: schemas.department },
        settings: { schema: schemas.settings }
    });

    console.log('Server Database Initialized (RxDB Memory)');
}

initDB();

// Authentication Middleware
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    const expectedToken = process.env.SYNC_TOKEN;

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    // Verify token against env var
    if (expectedToken && token !== expectedToken) {
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }

    next();
};

// REST API Endpoints

// GET All
app.get('/:collection', authMiddleware, async (req, res) => {
    const { collection } = req.params;
    if (!db || !db[collection]) return res.status(404).json({ error: 'Collection not found' });

    try {
        const docs = await db[collection].find().exec();
        res.json(docs.map(d => d.toJSON()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET One
app.get('/:collection/:id', authMiddleware, async (req, res) => {
    const { collection, id } = req.params;
    if (!db || !db[collection]) return res.status(404).json({ error: 'Collection not found' });

    try {
        const doc = await db[collection].findOne(id).exec();
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        res.json(doc.toJSON());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST (Create)
app.post('/:collection', authMiddleware, async (req, res) => {
    const { collection } = req.params;
    if (!db || !db[collection]) return res.status(404).json({ error: 'Collection not found' });

    try {
        const doc = await db[collection].insert(req.body);
        res.status(201).json(doc.toJSON());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT (Update/Upsert)
app.put('/:collection/:id', authMiddleware, async (req, res) => {
    const { collection, id } = req.params;
    if (!db || !db[collection]) return res.status(404).json({ error: 'Collection not found' });

    try {
        const doc = await db[collection].upsert(req.body);
        res.json(doc.toJSON());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE
app.delete('/:collection/:id', authMiddleware, async (req, res) => {
    const { collection, id } = req.params;
    if (!db || !db[collection]) return res.status(404).json({ error: 'Collection not found' });

    try {
        const doc = await db[collection].findOne(id).exec();
        if (doc) {
            await doc.remove();
            res.json({ ok: true });
        } else {
            res.status(404).json({ error: 'Document not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'TimeKiosk Sync Server Running (REST API)' });
});

// Start Server
if (httpsOptions.cert) {
    https.createServer(httpsOptions, app).listen(PORT, () => {
        console.log(`HTTPS Server running on port ${PORT}`);
    });
} else {
    app.listen(PORT, () => {
        console.log(`HTTP Server running on port ${PORT}`);
    });
}

export default app;

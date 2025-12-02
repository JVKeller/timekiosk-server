import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

// Enable plugins
// addRxPlugin(RxDBReplicationCouchDBPlugin); // Not strictly needed for custom HTTP sync but good to have if we switch

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

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
    db = await createRxDatabase({
        name: 'timekiosk_server_db',
        storage: getRxStorageMemory()
    });

    await db.addCollections({
        employees: { schema: schemas.employee },
        time_records: { schema: schemas.time_record },
        locations: { schema: schemas.location },
        departments: { schema: schemas.department },
        settings: { schema: schemas.settings }
    });

    console.log('Server Database Initialized');
}

initDB();

// Sync Endpoints
// We need endpoints for EACH collection or a generic one.
// For simplicity, let's do a generic one that takes collection name in URL.

app.post('/sync/:collection/pull', async (req, res) => {
    const { collection } = req.params;
    const { checkpoint, limit } = req.body;

    if (!db[collection]) {
        return res.status(404).json({ error: 'Collection not found' });
    }

    try {
        // RxDB internal function to get changes
        // In a real backend, you'd query your SQL/Mongo DB here.
        // Since we use RxDB on server too, we can use getChangedDocumentsSince

        // Note: getChangedDocumentsSince is part of RxStorage, but exposed via internal methods or we can just query.
        // For RxDB-to-RxDB sync via HTTP, we usually implement the replication protocol.
        // But here we are manually implementing the "backend" side of the replication-http plugin.

        // The replication-http plugin expects specific response format.
        // We need to fetch documents modified since the checkpoint.

        const minUpdatedAt = checkpoint ? checkpoint.updatedAt : 0;
        const lastId = checkpoint ? checkpoint.id : '';

        // This is a simplified query. 
        // Real implementation needs to handle "updatedAt" and sorting correctly.
        // RxDB documents have _meta.lwt (Last Write Time) usually.

        // Let's use a simple find for now.
        // Ideally we should use the storage instance directly to get changes.

        const result = await db[collection].find({
            selector: {
                // We need a way to filter by time. 
                // RxDB adds _meta field but it's internal.
                // For this prototype, let's assume we just send everything if no checkpoint, 
                // or we need to add a 'updatedAt' field to our schema if we want efficient sync?
                // Actually, RxDB's replication-http allows us to define the pull handler on client.
                // The server just needs to return what the client asks for.

                // If we use RxDB on server, we can use `exportJSON` or similar, but that's for backup.

                // Let's try to use the internal storage to get changes.
                // db[collection].storageInstance.getChangedDocumentsSince(...)
            }
        }).exec();

        // Filter manually for now (inefficient but works for prototype)
        // We need a reliable way to track changes.
        // Since we are using RxDB on server, we can just return all docs for now 
        // and let client handle diffs? No, that's bad for bandwidth.

        // Let's assume the client sends a checkpoint.
        // For the prototype, we will just return ALL documents and let RxDB client handle conflicts/duplicates.
        // This is "full sync" every time. Not production ready but "works".

        // Better: Use a timestamp field if available.

        const docs = result.map(d => d.toJSON());

        // Construct new checkpoint
        const lastDoc = docs[docs.length - 1];
        const newCheckpoint = lastDoc ? {
            id: lastDoc.id,
            updatedAt: new Date().getTime() // Mocking this
        } : checkpoint;

        res.json({
            documents: docs,
            checkpoint: newCheckpoint
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/sync/:collection/push', async (req, res) => {
    const { collection } = req.params;
    const changes = req.body; // Array of documents

    if (!db[collection]) {
        return res.status(404).json({ error: 'Collection not found' });
    }

    try {
        // Apply changes
        // changes is usually an array of { newDocumentState, assumedMasterState } or just docs?
        // The replication-http plugin sends an array of write rows.

        // If we just get an array of docs to upsert:
        const docs = changes.map(c => c.newDocumentState || c); // Handle both formats if possible

        for (const doc of docs) {
            await db[collection].upsert(doc);
        }

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'TimeKiosk Sync Server Running' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

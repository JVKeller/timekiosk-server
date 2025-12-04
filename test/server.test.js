import request from 'supertest';
import { expect } from 'chai';
import app from '../server.js';

describe('TimeKiosk Server API', () => {
    it('GET / should return status message', async () => {
        const res = await request(app)
            .get('/')
            .trustLocalhost(); // trust self-signed if needed, though supertest with app usually bypasses network

        // Note: supertest with an express app object doesn't use HTTPS by default, it mocks the request.
        // So we don't need to worry about certs here unless we explicitly start the server.

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('status', 'TimeKiosk Sync Server Running');
    });

    it('POST /sync/:collection/pull should return empty list', async () => {
        const res = await request(app)
            .post('/sync/employees/pull')
            .send({ checkpoint: null });

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('documents').that.is.an('array');
    });
});

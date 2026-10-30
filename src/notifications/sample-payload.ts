import { webhookPayload } from './delivery-contract.js';
export function samplePayload(id: string, installation: string, at: Date, origin: string) {
    return webhookPayload.parse({
        version: 1, type: 'security.test', action: 'test', test: true, notificationId: id, eventId: null, idempotencyKey: `notification-test:v1:${installation}:${id}`,
        notification: { title: 'Home Security · TEST', message: 'Explicit TEST. Synthetic person and zone; no real detection. The receiver may notify the configured test phone.' },
        camera: { channel: 1, name: 'Sample Camera 1' }, timestamps: { receivedAt: at.toISOString(), occurredAt: null }, rules: [],
        objects: [{ id: '10000000-0000-4000-8000-000000000001', category: 'PERSON', zoneIds: ['10000000-0000-4000-8000-000000000002'], zoneNames: [{ id: '10000000-0000-4000-8000-000000000002', name: 'Sample zone' }], zoneVersionIds: [], basis: 'stored_geometry_projection', locationReason: 'test_sample_not_geometric_evidence', uncertain: true }],
        ai: { status: 'pending', revision: null, summary: null }, images: [], dashboardUrl: origin + '/settings'
    });
}

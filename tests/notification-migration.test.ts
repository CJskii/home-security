import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { id, installation } from './helpers/notification-ledger.js';
const migration = readFileSync('prisma/migrations/20261021020000_notification_delivery/migration.sql', 'utf8');
it('applies exact additive SQL in RAM, preserves existing rows and enqueues atomically only after explicit arming', async () => {
    const db = new PGlite();
    try {
        // Synthetic source-table boundary plus the actual preceding notification schema.
        await db.exec('CREATE TABLE "SecurityEvent" (id UUID PRIMARY KEY,"sourceInstallationId" UUID NOT NULL,"firstReceivedAt" TIMESTAMPTZ(3) NOT NULL,"lastReceivedAt" TIMESTAMPTZ(3) NOT NULL);');
        await db.exec(readFileSync('prisma/migrations/20261020220000_notification_rules/migration.sql', 'utf8'));
        await db.query('INSERT INTO "NotificationConfiguration" VALUES ($1,1,$2,now())', [installation, { deliveryEnabled: false, rules: [] }]);
        await db.query('INSERT INTO "NotificationEvaluation" (id,"sourceInstallationId",fingerprint,"configurationRevision",configuration,result) VALUES ($1,$2,$3,1,$4,$5)', [id(9), installation, 'a'.repeat(64), { deliveryEnabled: false, rules: [] }, { preview: 'unchanged' }]);
        const source = async (n: number, at = '2026-10-21T12:00:01Z') => db.query('INSERT INTO "SecurityEvent" VALUES ($1,$2,$3,$3)', [id(n), installation, at]);
        await source(100);
        const prior = (await db.query('SELECT * FROM "SecurityEvent"')).rows;
        await db.exec(migration);
        expect((await db.query('SELECT * FROM "SecurityEvent"')).rows).toEqual(prior);
        expect((await db.query('SELECT kind,state,result FROM "NotificationEvaluation"')).rows).toEqual([{ kind: 'PREVIEW', state: 'AUDIT', result: { preview: 'unchanged' } }]);
        expect((await db.query('SELECT "producerEnabled","liveFromAt" FROM "NotificationConfiguration"')).rows).toEqual([{ producerEnabled: false, liveFromAt: null }]);
        await source(101);
        expect((await db.query("SELECT id FROM \"NotificationEvaluation\" WHERE kind='LIVE'")).rows).toHaveLength(0);
        // Test-only arm: no outbound transport is instantiated in this test.
        await db.query('UPDATE "NotificationConfiguration" SET "producerEnabled"=true,"liveFromAt"=$1', ['2026-10-21T12:00:00Z']);
        await source(102);
        await db.query('UPDATE "SecurityEvent" SET "lastReceivedAt"=now() WHERE id=$1', [id(102)]);
        expect((await db.query("SELECT \"eventId\",configuration,state FROM \"NotificationEvaluation\" WHERE kind='LIVE'")).rows).toEqual([{ eventId: id(102), configuration: { deliveryEnabled: false, rules: [] }, state: 'PENDING' }]);
        await source(103, '2026-10-20T12:00:00Z');
        expect((await db.query("SELECT id FROM \"NotificationEvaluation\" WHERE kind='LIVE'")).rows).toHaveLength(1);
        await db.exec('BEGIN');
        await source(104);
        await db.exec('ROLLBACK');
        expect((await db.query('SELECT id FROM "SecurityEvent" WHERE id=$1', [id(104)])).rows).toHaveLength(0);
        expect((await db.query('SELECT id FROM "NotificationEvaluation" WHERE "eventId"=$1', [id(104)])).rows).toHaveLength(0);
        // A failing optional queue write must not reject canonical capture.
        await db.query('INSERT INTO "NotificationEvaluation" (id,"sourceInstallationId",fingerprint,"configurationRevision",configuration,result) VALUES ($1,$2,$3,1,$4,$5)', [id(10), installation, 'live:' + id(105), { deliveryEnabled: false, rules: [] }, {}]);
        await source(105);
        expect((await db.query('SELECT id FROM "SecurityEvent" WHERE id=$1', [id(105)])).rows).toHaveLength(1);
        expect((await db.query('SELECT id FROM "NotificationEvaluation" WHERE "eventId"=$1', [id(105)])).rows).toHaveLength(0);
        // A least-privileged receiver without ledger permissions must still capture.
        await db.exec('CREATE ROLE notification_receiver_test; GRANT INSERT ON "SecurityEvent" TO notification_receiver_test; SET ROLE notification_receiver_test;');
        await source(106);
        await db.exec('RESET ROLE');
        expect((await db.query('SELECT id FROM "SecurityEvent" WHERE id=$1', [id(106)])).rows).toHaveLength(1);
        expect((await db.query("SELECT pg_advisory_xact_lock(hashtextextended('test',0))::text AS locked")).rows).toEqual([{ locked: '' }]);
        expect((await db.query<{
            indexname: string;
        }>("SELECT indexname FROM pg_indexes WHERE tablename='NotificationIntent'")).rows.map(r => r.indexname)).toContain('NotificationIntent_eventId_key');
    }
    finally {
        await db.close();
    }
}, 15000);

it('adds encrypted destination settings and isolated TEST identities without rewriting live data', async () => {
    const db = new PGlite();
    try {
        await db.exec('CREATE TABLE "SecurityEvent" (id UUID PRIMARY KEY,"sourceInstallationId" UUID NOT NULL,"firstReceivedAt" TIMESTAMPTZ(3) NOT NULL,"lastReceivedAt" TIMESTAMPTZ(3) NOT NULL);');
        await db.exec(readFileSync('prisma/migrations/20261020220000_notification_rules/migration.sql', 'utf8'));
        await db.exec(migration);
        await db.query('INSERT INTO "NotificationConfiguration" ("sourceInstallationId",configuration,"updatedAt") VALUES ($1,$2,now())', [installation, {deliveryEnabled:false,rules:[]}]);
        await db.query('INSERT INTO "SecurityEvent" VALUES ($1,$2,now(),now())', [id(200),installation]);
        await db.query('INSERT INTO "NotificationEvaluation" (id,"sourceInstallationId",fingerprint,"configurationRevision",configuration,result) VALUES ($1,$2,$3,1,$4,$5)', [id(201),installation,'old-live',{},{}]);
        await db.query('INSERT INTO "NotificationIntent" (id,"sourceInstallationId","eventId","evaluationId","destinationId",payload,"nextAttemptAt","expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now(),now(),now())',[id(202),installation,id(200),id(201),'old-target',{frozen:'payload'}]);
        const before=(await db.query<Record<string,unknown>>('SELECT * FROM "NotificationIntent"')).rows[0];
        await db.exec(readFileSync('prisma/migrations/20261021040000_webhook_settings/migration.sql','utf8'));
        expect((await db.query('SELECT * FROM "NotificationIntent"')).rows[0]).toEqual({...before,mode:'LIVE'});
        expect((await db.query('SELECT "deliveryRevision","deliveryConfiguration","deliverySecret","producerEnabled","liveFromAt",configuration FROM "NotificationConfiguration"')).rows).toEqual([{deliveryRevision:0,deliveryConfiguration:null,deliverySecret:null,producerEnabled:false,liveFromAt:null,configuration:{deliveryEnabled:false,rules:[]}}]);
        const insertTest=(n:number,mode='TEST')=>db.query('INSERT INTO "NotificationIntent" (id,mode,"sourceInstallationId","destinationId",payload,"nextAttemptAt","expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now(),now())',[id(n),mode,installation,'mock-only',{}]);
        await insertTest(203);await insertTest(204);
        await expect(insertTest(205,'LIVE')).rejects.toThrow(/notification_intent_mode/);
        await expect(db.query('UPDATE "NotificationIntent" SET mode=$1 WHERE id=$2',['TEST',id(202)])).rejects.toThrow(/notification_intent_mode/);
        expect((await db.query('SELECT id FROM "SecurityEvent"')).rows).toEqual([{id:id(200)}]);
        expect((await db.query('SELECT id FROM "NotificationIntent" WHERE mode=$1',['TEST'])).rows).toHaveLength(2);
    } finally {await db.close();}
},15000);
it('extends the existing mode constraint for one parent-linked UPDATE while preserving initial/TEST identities',async()=>{
 const db=new PGlite();try{
 await db.exec('CREATE TABLE "SecurityEvent" (id UUID PRIMARY KEY,"sourceInstallationId" UUID NOT NULL,"firstReceivedAt" TIMESTAMPTZ(3) NOT NULL,"lastReceivedAt" TIMESTAMPTZ(3) NOT NULL);');
 for(const path of ['20261020220000_notification_rules','20261021020000_notification_delivery','20261021040000_webhook_settings'])await db.exec(readFileSync(`prisma/migrations/${path}/migration.sql`,'utf8'));
 const insert=(n:number,mode:string,parent:string|null=null)=>db.query('INSERT INTO "NotificationIntent" (id,mode,"parentId","sourceInstallationId","destinationId",payload,"nextAttemptAt","expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now(),now(),now())',[id(n),mode,parent,installation,'mock-only',{}]);
 await db.query('INSERT INTO "NotificationIntent" (id,mode,"sourceInstallationId","destinationId",payload,"nextAttemptAt","expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now(),now())',[id(301),'TEST',installation,'mock-only',{frozen:true}]);
 const parent=(await db.query<Record<string,unknown>>('SELECT * FROM "NotificationIntent"')).rows[0];await db.exec(readFileSync('prisma/migrations/20261021180000_notification_ai_updates/migration.sql','utf8'));expect((await db.query('SELECT * FROM "NotificationIntent"')).rows[0]).toEqual({...parent,parentId:null});
 await insert(302,'UPDATE',id(301));await expect(insert(303,'UPDATE',id(301))).rejects.toThrow(/parentId_key/);await expect(insert(304,'UPDATE')).rejects.toThrow(/notification_enrichment_identity/);await expect(insert(305,'TEST',id(301))).rejects.toThrow();await expect(insert(306,'LIVE')).rejects.toThrow(/notification_intent_mode/);await expect(insert(307,'UPDATE',id(999))).rejects.toThrow(/parentId_fkey/);expect((await db.query('SELECT count(*)::int n FROM "SecurityEvent"')).rows[0]).toEqual({n:0});
 }finally{await db.close();}
},15000);

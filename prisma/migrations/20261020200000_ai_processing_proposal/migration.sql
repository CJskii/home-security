-- Additive, operator-applied only. No historical analysis/source changes.
CREATE TABLE "AiProcessingProposal" (
  "sourceInstallationId" UUID NOT NULL,
  "configuration" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "AiProcessingProposal_pkey" PRIMARY KEY ("sourceInstallationId"),
  CONSTRAINT "AiProcessingProposal_object" CHECK (jsonb_typeof("configuration") = 'object')
);

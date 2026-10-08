import { join } from 'node:path';
import { clusterProjectRecordSchema, slurmDevelopmentReviewResultSchema } from '@dock/shared';
import type { Runtime } from './runtime.js';
import { ClusterProjects } from './cluster-projects.js';
import { ClusterProjectRuntimes } from './cluster-runtime.js';
import {
  ClusterDevelopmentAllocations,
  DevelopmentReviewHeld,
  developmentProposal,
} from './cluster-development.js';
import { ClusterAdmissionController } from './cluster-admission-controller.js';
import { ClusterAdmissionLedgers } from './cluster-admission-ledger.js';
import { createClusterBundlePreparer } from './cluster-deployment.js';
import { readClusterSourceConfig } from './cluster-source-config.js';
import { clusterIdleProofSchema } from './cluster-runtime-idle.js';
import { sshRunner } from './cluster.js';

/** Controller-only services. Construction performs no SSH, allocation or model work. */
export function createClusterControllerServices(runtime: Runtime, sourceRepo: string) {
  if (!runtime.clusterWorkspace) return undefined;
  const store = runtime.store;
  const source = readClusterSourceConfig(runtime.dataDir);
  const prepare = source.config
    ? createClusterBundlePreparer({
        runner: sshRunner,
        sourceRepo,
        revision: source.config.revision,
        cacheDir: join(runtime.dataDir, 'cluster-bundles'),
      })
    : null;
  const runtimes = new ClusterProjectRuntimes(
    store,
    new ClusterDevelopmentAllocations(
      store,
      undefined,
      undefined,
      async (input, lease) => {
        if (!lease.jobId) return null;
        const record = clusterProjectRecordSchema.parse(
          store.getSetting(`cluster-project:${input.projectId}`),
        );
        const response = await runtimes
          .gateway(input.projectId)
          .forward(
            record.hostId,
            'POST',
            '/api/cluster/runtime/admission/drain',
            { key: lease.token },
            AbortSignal.timeout(20000),
          );
        const bytes: Buffer[] = [];
        let size = 0;
        try {
          if (response.statusCode !== 200) return null;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 4000) return null;
            bytes.push(Buffer.from(chunk));
          }
          const raw: unknown = JSON.parse(Buffer.concat(bytes).toString());
          return raw === null ? null : clusterIdleProofSchema.parse(raw);
        } finally {
          response.destroy();
        }
      },
      async (input, lease) => {
        projects.requireOpenIntent(input.projectId);
        if (!prepare) throw new Error(source.error!);
        const record = projects.record(input.projectId);
        const policy = runtime.slurmReview.policy().policy;
        if (!policy.enabled) {
          if (!store.getSetting('slurm-review:policy') && record.slurmReviewPolicy?.enabled)
            throw new Error(
              'This project retains an enabled Slurm review policy. Restore that policy in submission settings before opening its development allocation.',
            );
          store.operation(
            `cluster-development:review-disabled:${lease.token}`,
            {
              projectId: input.projectId,
              configuration: lease.configuration,
            },
            () => {
              store.event('cluster.development.review_disabled', null, null, {
                projectId: input.projectId,
                leaseToken: lease.token,
              });
              return true;
            },
          );
          return () => {
            projects.requireOpenIntent(input.projectId);
            if (runtime.slurmReview.policy().policy.enabled)
              throw new Error(
                'Slurm review was enabled before submission. Explicitly reopen for review.',
              );
          };
        }
        const proposal = developmentProposal(input, lease);
        const result = runtime.slurmReview.requestDevelopmentReview({
          key: lease.token,
          clusterProjectId: input.projectId,
          clusterProjectName: record.name,
          command: proposal.command,
          script: proposal.script,
          purpose: proposal.purpose,
          workingDirectory: input.path,
        });
        store.setSetting(`cluster-project-review:${input.projectId}`, { id: result.reviewId });
        runtime.kick();
        if (!result.allowed) throw new DevelopmentReviewHeld(result);
        return () => {
          projects.requireOpenIntent(input.projectId);
          if (!runtime.slurmReview.get(result.reviewId).allowsSubmission)
            throw new Error(
              'The allocation approval changed before submission. Explicitly reopen for review.',
            );
        };
      },
    ),
    async (record, lease) => {
      if (!prepare) throw new Error(source.error!);
      const bundle = await prepare(record, lease);
      return {
        ...bundle,
        codexPath: source.config?.codexBin ?? bundle.codexPath,
        claudePath: source.config?.claudeBin ?? bundle.claudePath,
      };
    },
  );
  const projects = new ClusterProjects(
    store,
    runtime.clusterWorkspace,
    runtimes,
    () => runtime.cluster.settings(),
    (id) => {
      if (!runtime.slurmReview.policy().policy.enabled) return null;
      const saved = store.getSetting(`cluster-project-review:${id}`) as { id: string } | null;
      if (!saved) return null;
      try {
        const view = runtime.slurmReview.get(saved.id);
        return slurmDevelopmentReviewResultSchema.parse({
          reviewId: view.id,
          status: view.status,
          pending: ['waiting_evidence', 'queued', 'running'].includes(view.status),
          allowed: view.allowsSubmission,
          disposition: view.disposition,
          message: view.message,
        });
      } catch {
        return null;
      }
    },
  );
  const ledgers = new ClusterAdmissionLedgers(join(runtime.dataDir, 'cluster-admission'), () =>
    runtime.modelPolicy.policy(),
  );
  const broker = new ClusterAdmissionController(store, projects, ledgers);
  const unwatchReview = runtime.slurmReview.onSettled(() => {
    void projects.tickPending().catch(() => {
      // The saved intent remains available to the bounded controller timer or explicit Open.
    });
  });
  projects.admission = broker;
  return {
    projects,
    start() {
      projects.start();
      broker.start();
    },
    async close() {
      unwatchReview();
      projects.close();
      await broker.close();
      await runtimes.close();
      await ledgers.close();
    },
  };
}

import { type ClusterProjectRecord, clusterSettingsSchema } from '@dock/shared';
import { Conflict, type Store } from './store.js';
import { WorkspaceState } from './workspace-state.js';
import { FolderConnections } from './folder-picker.js';
import { dirname } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

/** A login and compute host can mount the same shared folder with different st_dev values. */
function clusterFolderBinding(store: Store, record: ClusterProjectRecord) {
  const root = record.folder.path;
  const expectedInode = record.folder.directoryIdentity?.split(':')[1];
  const stat = lstatSync(root, { bigint: true });
  // Older descriptors lack an owner snapshot; accept only the verified runtime user's folder.
  const expectedOwner = record.folder.directoryOwnerUid ?? process.getuid?.();
  if (
    !expectedInode ||
    !/^\d+:\d+$/.test(record.folder.directoryIdentity ?? '') ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(root) !== root ||
    String(stat.ino) !== expectedInode ||
    expectedOwner === undefined ||
    stat.uid !== BigInt(expectedOwner)
  )
    throw new Conflict('The saved cluster folder identity changed. Refresh and choose it again.');
  const binding = {
    projectId: record.id,
    path: root,
    username: record.folder.username,
    inode: String(stat.ino),
    ownerUid: Number(stat.uid),
  };
  const prior = store.getSetting('cluster:folder-binding');
  if (
    prior &&
    Object.entries(binding).some(
      ([key, value]) => (prior as Record<string, unknown>)[key] !== value,
    )
  )
    throw new Conflict('The saved remote project folder binding changed; history was retained.');
  const identity = `${Number(stat.dev)}:${Number(stat.ino)}`;
  const key = `project-folder:${record.id}`;
  const receipt = store.getSetting(key) as Record<string, unknown> | null;
  if (receipt && receipt.identity !== identity) {
    // Only this exact cluster bootstrap receipt may move between compute mount identities.
    if (
      receipt.root !== root ||
      receipt.provider !== record.manager.provider ||
      receipt.name !== record.name ||
      receipt.fresh !== true ||
      typeof receipt.identity !== 'string' ||
      receipt.identity.split(':')[1] !== expectedInode
    )
      throw new Conflict('The saved cluster folder receipt changed; history was retained.');
  }
  store.transaction(() => {
    if (!prior) store.setSetting('cluster:folder-binding', binding);
    if (receipt && receipt.identity !== identity) {
      store.setSetting(key, { ...receipt, identity });
      store.event('cluster.folder_identity_rebound', null, null, { projectId: record.id });
    }
  });
  return { binding, identity };
}

/** No provider process or Runtime exists during this recoverable first-run registration. */
export async function initializeClusterProject(
  store: Store,
  record: ClusterProjectRecord,
  settings: unknown,
) {
  const hostId = new WorkspaceState(store).hostId;
  let project: ReturnType<Store['project']>;
  const saved = store.getSetting('cluster:project-identity') as {
    localProjectId: string;
    projectId: string;
    managerId: string;
  } | null;
  if (saved) {
    if (saved.localProjectId !== record.id)
      throw new Error('Remote native history belongs to a different project.');
    project = store.project(saved.projectId);
    if (project.managerId !== saved.managerId || project.root !== record.folder.path)
      throw new Error('Saved remote manager or folder identity changed.');
    if (
      (record.remoteWorkspaceId && record.remoteWorkspaceId !== hostId) ||
      (record.remoteProjectId && record.remoteProjectId !== project.id) ||
      (record.remoteManagerId && record.remoteManagerId !== project.managerId)
    )
      throw new Error('Controller remote history identity no longer matches.');
  }
  const folder = clusterFolderBinding(store, record);
  const folders = new FolderConnections(store, dirname(store.path), null);
  if (!saved) {
    store.setSetting('model-policy', record.policy);
    // register owns its own transaction and durable fresh-key receipt.
    const registered = await folders.connectPreparedFolder(
      record.id,
      record.folder.path,
      record.manager.provider,
      record.name,
      record.description,
      folder.identity,
      !!record.trackingConsent &&
        record.trackingConsent.folderIdentity === record.folder.directoryIdentity,
    );
    project = store.project(registered.id);
    store.transaction(() => {
      store.updateAgent(project.managerId, {
        model: record.manager.model,
        effort: record.manager.effort,
      });
      store.setSetting(`project-workflow:${project.id}`, record.folder.workflow);
      store.setSetting('cluster:project-identity', {
        localProjectId: record.id,
        projectId: project.id,
        managerId: project.managerId,
      });
      store.setSetting('cluster:folder-binding', folder.binding);
    });
  } else {
    const selection = await folders.inspect(record.folder.path);
    if (selection.needsTracking || selection.identity !== folder.identity)
      throw new Error('Saved remote project tracking or folder identity changed.');
    project = store.project(saved.projectId);
  }
  if (
    (record.remoteWorkspaceId && record.remoteWorkspaceId !== hostId) ||
    (record.remoteProjectId && record.remoteProjectId !== project.id) ||
    (record.remoteManagerId && record.remoteManagerId !== project.managerId)
  )
    throw new Error('Controller remote history identity no longer matches.');
  if (record.slurmReviewPolicy) {
    const previous = store.getSetting('slurm-review:controller-policy');
    const current = store.getSetting('slurm-review:policy');
    // A remote owner edit diverges from the last imported global snapshot and is preserved.
    if (!current || JSON.stringify(current) === JSON.stringify(previous)) {
      store.setSetting('slurm-review:policy', record.slurmReviewPolicy);
      store.setSetting('slurm-review:controller-policy', record.slurmReviewPolicy);
    }
  }
  store.setSetting('cluster:v1:settings', clusterSettingsSchema.parse(settings));
  return { hostId, project };
}

import { useEffect, useState, type ReactNode } from 'react';
import {
  clusterProjectListSchema,
  clusterWorkspaceSchema,
  type ClusterProjectSummary,
  type ClusterWorkspaceStatus,
} from '@dock/shared';
import { apiCluster, apiScope, controllerApi } from '../api';
import { ClusterWorkspace } from './ClusterWorkspace';
import './cluster-project-destination.css';

export type ClusterProjectDiscovery = {
  workspace: ClusterWorkspaceStatus;
  projects: ClusterProjectSummary[];
};

// Optional routes are discovered once per document/computer, including StrictMode remounts.
// Missing, malformed or failed replies never advertise remote project support or poll 404s.
const discoveries = new Map<string, Promise<ClusterProjectDiscovery | null>>();
export function useClusterProjectDiscovery() {
  const [state, setState] = useState<ClusterProjectDiscovery | null>(null);
  useEffect(() => {
    if (apiCluster()) return;
    let alive = true;
    const scope = apiScope();
    let request = discoveries.get(scope);
    if (!request) {
      request = Promise.all([
        controllerApi('/cluster/workspace', undefined, undefined, 15_000),
        controllerApi('/cluster/projects', undefined, undefined, 15_000),
      ])
        .then(([workspace, projects]) => ({
          workspace: clusterWorkspaceSchema.parse(workspace),
          projects: clusterProjectListSchema.parse(projects),
        }))
        .catch(() => null);
      discoveries.set(scope, request);
    }
    void request.then((value) => {
      if (alive) setState(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** Optional settings mount only after both typed controller routes answered successfully. */
export function ClusterWorkspaceSetup({ panelConnected }: { panelConnected: boolean }) {
  const discovery = useClusterProjectDiscovery();
  return discovery ? (
    <ClusterWorkspace initial={discovery.workspace} panelConnected={panelConnected} />
  ) : null;
}

/**
 * The controller supplies its verified create/open handler at integration time. Until then,
 * local setup remains the only destination even if partial backend routes have been installed.
 * Keeping local mounted preserves the existing folder browser, typed name and first brief.
 */
export function ClusterProjectDestination({
  heading,
  local,
  cluster,
}: {
  heading: ReactNode;
  local: (heading: ReactNode) => ReactNode;
  cluster?: (discovery: ClusterProjectDiscovery) => ReactNode;
}) {
  const discovery = useClusterProjectDiscovery();
  const destinationKey = `dock:${apiScope()}:new-project-destination`;
  const [selected, setSelected] = useState(() => {
    try {
      return sessionStorage.getItem(destinationKey) === 'cluster';
    } catch {
      return false;
    }
  });
  const choose = (value: boolean) => {
    setSelected(value);
    try {
      sessionStorage.setItem(destinationKey, value ? 'cluster' : 'local');
    } catch {
      // Selecting a destination is reversible; durable creation checks storage separately.
    }
  };
  const available = !!discovery && !!cluster && !apiCluster();
  const remote = selected && available;
  const choice = available ? (
    <div className="project-destination" role="radiogroup" aria-label="Where the project runs">
      {(
        [
          [false, 'This computer'],
          [true, 'Cluster project'],
        ] as const
      ).map(([value, label]) => (
        <label key={label} className={remote === value ? 'selected' : ''}>
          <input
            type="radio"
            name="project-destination"
            checked={remote === value}
            onChange={() => choose(value)}
          />
          {label}
        </label>
      ))}
    </div>
  ) : null;
  return (
    <>
      <div hidden={remote}>
        {local(
          <>
            {heading}
            {!remote && choice}
          </>,
        )}
      </div>
      {remote && discovery && cluster && (
        <section className="flow-page project-config">
          {heading}
          {choice}
          {cluster(discovery)}
        </section>
      )}
    </>
  );
}

export type ClusterFolderSelection = { folderId: string; name: string; nameEdited: boolean };

const developmentLabels: Record<ClusterProjectSummary['development']['state'], string> = {
  absent: 'No allocation yet',
  allocating: 'Requesting allocation',
  uncertain: 'Checking allocation',
  pending: 'Waiting in Slurm',
  ready: 'Allocation running',
  disconnected: 'Allocation not reachable',
  idle: 'Allocation idle',
  released: 'Allocation released',
  rejected: 'Slurm rejected the request',
  error: 'Allocation problem',
};

/** Opening stays with the controller's typed handler; this list cannot choose a route or host. */
export function ClusterProjectList({
  projects,
  onOpen,
  busyId = null,
}: {
  projects: ClusterProjectSummary[];
  onOpen: (projectId: string) => void;
  busyId?: string | null;
}) {
  if (!projects.length) return null;
  return (
    <section className="cluster-project-list" aria-label="Cluster projects">
      <h3>Cluster projects</h3>
      {projects.map((project) => (
        <div className="cluster-project-row" key={project.id}>
          <span>
            <strong>{project.name}</strong>
            <small>
              {project.alias} · {developmentLabels[project.development.state]}
              {project.setupRequired && ' · setup needed'}
            </small>
          </span>
          <button
            type="button"
            className="flow-button"
            disabled={!!busyId}
            onClick={() => onOpen(project.id)}
          >
            {busyId === project.id ? 'Opening…' : 'Open'}
          </button>
        </div>
      ))}
    </section>
  );
}

/** Browser launches select server-generated IDs; saved root paths are setup metadata only. */
export function ClusterProjectFolderPicker({
  workspace,
  value,
  onChange,
  disabled = false,
}: {
  workspace: ClusterWorkspaceStatus;
  value: ClusterFolderSelection;
  onChange: (value: ClusterFolderSelection) => void;
  disabled?: boolean;
}) {
  const folders = workspace.roots.flatMap((root) =>
    root.index.entries
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => ({
        id: entry.id,
        name: entry.relativePath === '.' ? root.label : entry.relativePath.split('/').at(-1)!,
        label: entry.relativePath === '.' ? root.label : `${root.label} / ${entry.relativePath}`,
        current:
          workspace.connected &&
          root.index.connectionId === workspace.connectionId &&
          ['ready', 'truncated'].includes(root.index.state),
      })),
  );
  return (
    <fieldset className="config-section cluster-project-folder" disabled={disabled}>
      <legend>Cluster project</legend>
      <label>
        Folder on the cluster
        <select
          value={value.folderId}
          onChange={(event) => {
            const folder = folders.find((item) => item.id === event.target.value);
            onChange({
              ...value,
              folderId: event.target.value,
              name: value.nameEdited ? value.name : (folder?.name ?? ''),
            });
          }}
        >
          <option value="">Choose a saved folder</option>
          {value.folderId && !folders.some((folder) => folder.id === value.folderId) && (
            <option value={value.folderId} disabled>
              Saved folder needs refresh
            </option>
          )}
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id} disabled={!folder.current}>
              {folder.label}
              {!folder.current && ' · needs refresh'}
            </option>
          ))}
        </select>
      </label>
      <label>
        Project name
        <input
          required
          maxLength={100}
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value, nameEdited: true })}
        />
      </label>
      <p className="config-help">The name shown in the app. Your folder keeps its name.</p>
      {!folders.some((folder) => folder.current) && (
        <p className="config-help">Save a folder and refresh its listing in QUARK cluster setup.</p>
      )}
    </fieldset>
  );
}

import { projectFolderSelectionSchema } from '@dock/shared';
import { apiScope } from '../api';
import { CopyPrompt } from './GroupSetupPrompt';
import { groupCreationSetupPrompt } from './group-creation-prompt';
/** Creator context stays in this browser/computer scope; it is never published. */
export function CreatedGroupSetup({ handle }: { handle: string }) {
  try {
    const draft = JSON.parse(
      sessionStorage.getItem(`swa:groups:${apiScope()}:creation-context:${handle}`) ?? 'null',
    );
    if (
      !draft ||
      draft.created !== handle ||
      typeof draft.name !== 'string' ||
      typeof draft.project !== 'string'
    )
      return null;
    const selection =
      draft.choice === 'folder' ? projectFolderSelectionSchema.parse(draft.selection) : null;
    const prompt = groupCreationSetupPrompt({
      displayName: draft.name,
      projectName: draft.project,
      selection,
      folderSelected: draft.choice === 'folder',
      groupHandle: handle,
    });
    return (
      <>
        {draft.folderProblem && (
          <p role="status">
            Group created. Folder not attached: {draft.folderProblem} Use Manage → Work folder to
            repair it; do not create another group.
          </p>
        )}
        <details className="group-host-status">
          <summary>Your saved setup choices</summary>
          <p>
            This group already exists. Give this contextual prompt to your existing agent for any
            remaining optional repository setup.
          </p>
          <CopyPrompt
            key={prompt}
            label="Saved group setup prompt"
            button="Copy saved setup prompt"
            text={prompt}
          />
        </details>
      </>
    );
  } catch {
    return null;
  }
}

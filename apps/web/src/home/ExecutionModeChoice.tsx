export type CreationExecutionMode = 'direct' | 'managed';

/** This is a new creation choice, never a conversion of a retained native session. */
export function ExecutionModeChoice({
  value,
  disabled,
  change,
}: {
  value?: CreationExecutionMode;
  disabled: boolean;
  change: (value: CreationExecutionMode) => void;
}) {
  return (
    <fieldset className="config-section execution-mode-choice" disabled={disabled}>
      <legend>Conversation setup</legend>
      <label>
        Run with
        <select
          value={value ?? 'retained'}
          onChange={(event) => change(event.target.value as CreationExecutionMode)}
        >
          {!value && <option value="retained">Keep this saved setup</option>}
          <option value="direct">Native agent</option>
          <option value="managed">Managed setup · optional</option>
        </select>
      </label>
      <p className="config-help">
        {value === 'direct'
          ? 'Use the native agent’s tools, skills and permissions. No app manager, team tools or QUARK admission. This conversation runs through this app; it does not connect an external terminal session.'
          : value === 'managed'
            ? 'Add the app’s manager, delegated tasks and optional QUARK controls. Existing native conversations are kept separate.'
            : 'This unfinished request keeps its original choices and retry identity. Choosing another setup makes a new request before creation.'}
      </p>
    </fieldset>
  );
}

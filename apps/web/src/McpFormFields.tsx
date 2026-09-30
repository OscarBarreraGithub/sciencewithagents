import { useId } from 'react';
import { mcpFormOptions, type McpForm, type McpFormValues } from '@dock/shared';

export function McpFormFields({
  form,
  values,
  onChange,
}: {
  form: McpForm;
  values: McpFormValues;
  onChange: (name: string, value: McpFormValues[string] | undefined) => void;
}) {
  const prefix = useId();
  return (
    <div className="mcp-form-fields">
      <p className="mcp-form-notice">
        Answers go to <strong>{form.serverName}</strong> and are retained in your local history. Do
        not enter passwords, API keys or payment details.
      </p>
      {Object.entries(form.requestedSchema.properties).map(([name, field], index) => {
        const labelId = `${prefix}-${index}`,
          helpId = `${labelId}-help`;
        const required = form.requestedSchema.required?.includes(name);
        const value = values[name],
          options = mcpFormOptions(field);
        const accessibility = {
          'aria-labelledby': labelId,
          'aria-describedby': field.description ? helpId : undefined,
        };
        return (
          <fieldset className="mcp-form-field" key={name}>
            <legend id={labelId}>
              {field.title ?? name}
              {required ? ' *' : ' (optional)'}
            </legend>
            {field.type === 'array' ? (
              options!.map((option) => (
                <label className="mcp-form-choice" key={option.value}>
                  <input
                    type="checkbox"
                    checked={Array.isArray(value) && value.includes(option.value)}
                    onChange={(event) => {
                      const selected = Array.isArray(value) ? value : [];
                      const next = event.target.checked
                        ? [...selected, option.value]
                        : selected.filter((item) => item !== option.value);
                      onChange(name, !required && !next.length ? undefined : next);
                    }}
                  />
                  <span>{option.label || '(empty)'}</span>
                </label>
              ))
            ) : field.type === 'boolean' ? (
              <select
                {...accessibility}
                value={typeof value === 'boolean' ? String(value) : ''}
                onChange={(event) =>
                  onChange(
                    name,
                    event.target.value === '' ? undefined : event.target.value === 'true',
                  )
                }
              >
                <option value="">Choose an answer…</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : field.type === 'number' || field.type === 'integer' ? (
              <input
                {...accessibility}
                type="number"
                value={typeof value === 'number' ? value : ''}
                step={field.type === 'integer' ? 1 : 'any'}
                min={field.minimum}
                max={field.maximum}
                onChange={(event) =>
                  onChange(name, event.target.value === '' ? undefined : Number(event.target.value))
                }
              />
            ) : options ? (
              <select
                {...accessibility}
                value={
                  typeof value === 'string'
                    ? String(options.findIndex((option) => option.value === value))
                    : ''
                }
                onChange={(event) =>
                  onChange(
                    name,
                    event.target.value === ''
                      ? undefined
                      : options[Number(event.target.value)]?.value,
                  )
                }
              >
                <option value="">Choose an answer…</option>
                {options.map((option, index) => (
                  <option value={index} key={option.value}>
                    {option.label || '(empty)'}
                  </option>
                ))}
              </select>
            ) : field.type === 'string' ? (
              <input
                {...accessibility}
                type="text"
                autoComplete="off"
                value={typeof value === 'string' ? value : ''}
                maxLength={8000}
                placeholder={field.format}
                onChange={(event) =>
                  onChange(
                    name,
                    !required && event.target.value === '' ? undefined : event.target.value,
                  )
                }
              />
            ) : null}
            {field.description && <p id={helpId}>{field.description}</p>}
          </fieldset>
        );
      })}
    </div>
  );
}

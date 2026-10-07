import { useState } from 'react';
import { PromptCard } from '../SetupPrompt';

type Provider = 'codex' | 'claude';
const commands = {
  codex: [
    {
      label: 'Install latest CLI',
      command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    },
    {
      label: 'Update standalone install',
      command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    },
    { label: 'Update npm install', command: 'npm install -g @openai/codex@latest' },
    { label: 'Update Homebrew install', command: 'brew update\nbrew upgrade --cask codex' },
  ],
  claude: [
    { label: 'Install latest CLI', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    { label: 'Update native / npm install', command: 'claude update' },
    { label: 'Update Homebrew stable', command: 'brew update\nbrew upgrade --cask claude-code' },
    {
      label: 'Update Homebrew latest',
      command: 'brew update\nbrew upgrade --cask claude-code@latest',
    },
  ],
};

export function ProviderCliSetup({ initialProvider }: { initialProvider: Provider }) {
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [method, setMethod] = useState(0);
  const choice = commands[provider][method]!;
  return (
    <details className="welcome-cli-setup">
      <summary>Install or update Codex / Claude</summary>
      <p>
        Only have the desktop app? Install its terminal tool here. You only need one provider. Run
        these commands in Terminal on the computer that will run your agents.
      </p>
      <div className="welcome-cli-choices">
        <label>
          Provider
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as Provider);
              setMethod(0);
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          Install or update method
          <select value={method} onChange={(event) => setMethod(Number(event.target.value))}>
            {commands[provider].map((item, index) => (
              <option key={item.label} value={index}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <PromptCard
        key={`${provider}:${method}`}
        label={choice.label.includes('Homebrew') ? 'Terminal · macOS' : 'Terminal · macOS / Linux'}
        prompt={choice.command}
      />
      <p>
        Already installed? Choose its existing update method above; keep any deliberate version pin.
        For other installers, follow the{' '}
        <a
          href={
            provider === 'codex'
              ? 'https://learn.chatgpt.com/docs/codex/cli'
              : 'https://code.claude.com/docs/en/setup'
          }
          target="_blank"
          rel="noreferrer"
        >
          official setup guide
        </a>
        .
      </p>
      <p>
        Open a new Terminal window, run <code>{provider} --version</code>, then{' '}
        <code>{provider}</code> and complete sign-in with your own{' '}
        {provider === 'codex' ? 'ChatGPT' : 'Claude subscription'} account if asked. Return here and
        choose <strong>Check this computer</strong>.
      </p>
      <p className="welcome-fine">
        Command not found, or still seeing an old version? Ask your setup agent to check the CLI
        path and launcher configuration before safely reopening the app.
      </p>
    </details>
  );
}

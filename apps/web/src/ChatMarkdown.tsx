import { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { DocumentLink } from './Documents';
import { prepareChatMath } from './chatMath';
import 'katex/dist/katex.min.css';
import './chatMath.css';
import { savedDocumentLinks } from '@dock/shared';

const imagePlaceholder: Components['img'] = ({ alt }) => (
  <span className="muted">[Image: {alt ?? 'image'}]</span>
);

/** One always-on renderer for messages, shared editor chats and resource reports. */
export const ChatMarkdown = memo(
  function ChatMarkdown({
    children,
    image = imagePlaceholder,
    report = false,
    entry,
  }: {
    children: string;
    image?: Components['img'];
    report?: boolean;
    entry?: { agentId: string; id: string };
  }) {
    const prepared = useMemo(() => prepareChatMath(children), [children]);
    const links = useMemo(() => savedDocumentLinks(children), [children]);
    return (
      <div className="chat-markdown">
        <ReactMarkdown
          urlTransform={(url) => (entry && links.includes(url) ? url : defaultUrlTransform(url))}
          remarkPlugins={[remarkGfm, prepared.remarkChatMath]}
          rehypePlugins={[
            [
              rehypeKatex,
              {
                trust: false,
                strict: 'ignore',
                maxExpand: 1000,
                maxSize: 20,
                output: 'htmlAndMathml',
                errorColor: 'currentColor',
              },
            ],
          ]}
          components={{
            a: report
              ? ({ children }) => <span>{children}</span>
              : ({ href, children }) => (
                  <DocumentLink
                    href={href}
                    saved={
                      entry && href && links.indexOf(href) >= 0
                        ? { agentId: entry.agentId, entryId: entry.id, index: links.indexOf(href) }
                        : undefined
                    }
                  >
                    {children}
                  </DocumentLink>
                ),
            img: image,
          }}
        >
          {prepared.text}
        </ReactMarkdown>
      </div>
    );
  },
  (before, after) =>
    before.children === after.children &&
    before.report === after.report &&
    before.image === after.image &&
    before.entry?.id === after.entry?.id &&
    before.entry?.agentId === after.entry?.agentId,
);

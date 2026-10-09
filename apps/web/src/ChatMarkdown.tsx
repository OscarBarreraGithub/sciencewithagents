import { memo, useMemo, type ComponentType, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { DocumentLink } from './Documents';
import { GroupDocumentLink, useGroupDocumentScope } from './groups/GroupDocumentLink';
import { groupDocumentReference } from '@dock/shared/dist/group-documents.js';
import { prepareChatMath } from './chatMath';
import 'katex/dist/katex.min.css';
import './chatMath.css';
import { savedDocumentLinks, chatImageId, chatFileId } from '@dock/shared';
import { ChatFileCard } from './ChatImages';
import { ImagePreview } from './ImagePreview';
import { apiUrl } from './api';
import './chatImages.css';

const imagePlaceholder = ({ alt }: ComponentProps<'img'>) => (
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
    image?: ComponentType<ComponentProps<'img'>>;
    report?: boolean;
    entry?: { agentId: string; id: string };
  }) {
    const groupScope = useGroupDocumentScope();
    const prepared = useMemo(
      () =>
        prepareChatMath(
          children.replace(
            /\n\n<!-- sciencewithagents (?:screenshot|file) attachments:[\s\S]*?\n-->/g,
            '',
          ),
        ),
      [children],
    );
    const links = useMemo(() => savedDocumentLinks(children), [children]);
    const OtherImage = image;
    return (
      <div className="chat-markdown">
        <ReactMarkdown
          urlTransform={(url) =>
            chatImageId(url) || chatFileId(url) || (entry && links.includes(url))
              ? url
              : defaultUrlTransform(url)
          }
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
            a: ({ href, children }) => {
              const fileId = href ? chatFileId(href) : null;
              if (fileId)
                return groupScope ? (
                  <span>{children}</span>
                ) : (
                  <ChatFileCard key={fileId} id={fileId} />
                );
              if (href && groupDocumentReference(href))
                return report ? (
                  <span>{children}</span>
                ) : (
                  <GroupDocumentLink href={href}>{children}</GroupDocumentLink>
                );
              if (groupScope)
                return !report && href && /^(https?:|mailto:)/i.test(href) ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                );
              return report ? (
                <span>{children}</span>
              ) : (
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
              );
            },
            img: ({ src, alt, ...props }) => {
              const id = typeof src === 'string' ? chatImageId(src) : null;
              return id && !groupScope ? (
                <ImagePreview
                  className="chat-uploaded-image"
                  src={apiUrl(`/chat-images/${id}`)}
                  alt={alt || 'Screenshot'}
                />
              ) : (
                <OtherImage src={src} alt={alt} {...props} />
              );
            },
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

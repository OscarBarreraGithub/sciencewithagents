import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { DocumentLink } from './Documents';
import { prepareChatMath } from './chatMath';
import 'katex/dist/katex.min.css';
import './chatMath.css';

const imagePlaceholder: Components['img'] = ({ alt }) => (
  <span className="muted">[Image: {alt ?? 'image'}]</span>
);

/** One always-on renderer for messages, shared editor chats and resource reports. */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  image = imagePlaceholder,
  report = false,
}: {
  children: string;
  image?: Components['img'];
  report?: boolean;
}) {
  const prepared = useMemo(() => prepareChatMath(children), [children]);
  return (
    <div className="chat-markdown">
      <ReactMarkdown
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
          a: report ? ({ children }) => <span>{children}</span> : DocumentLink,
          img: image,
        }}
      >
        {prepared.text}
      </ReactMarkdown>
    </div>
  );
});

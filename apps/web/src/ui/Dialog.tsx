import { type CSSProperties, type ReactNode } from 'react';
import { Modal, ModalOverlay } from 'react-aria-components/Modal';
import { Dialog as AriaDialog } from 'react-aria-components/Dialog';
import { Heading } from 'react-aria-components/Heading';
import { X } from 'lucide-react';
import { useVisibleViewport } from '../useVisibleViewport';
import { Button } from './Button';

/** Controlled dialog with focus containment/restoration and Escape/outside dismissal. */
export function Dialog({
  title,
  close,
  children,
  className = '',
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  className?: string;
}) {
  const view = useVisibleViewport();
  const viewportStyle: CSSProperties | undefined = view
    ? { top: view.top, height: view.height }
    : undefined;
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) close();
      }}
      className="ui-dialog-overlay"
      style={viewportStyle}
    >
      <Modal className="ui-dialog-modal">
        <AriaDialog className={`ui-dialog ${className}`}>
          <div className="modal-heading">
            <Heading slot="title">{title}</Heading>
            <Button aria-label="Close dialog" className="ui-icon-button" onPress={close}>
              <X size={20} aria-hidden="true" />
            </Button>
          </div>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

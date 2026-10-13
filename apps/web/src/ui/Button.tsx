import { forwardRef } from 'react';
import {
  Button as AriaButton,
  type ButtonProps as AriaButtonProps,
} from 'react-aria-components/Button';

export interface ButtonProps extends Omit<AriaButtonProps, 'className'> {
  className?: string;
  variant?: 'secondary' | 'primary' | 'quiet';
}

/** One press/focus model for touch, keyboard and pointer controls. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant = 'secondary', ...props },
  ref,
) {
  return (
    <AriaButton {...props} ref={ref} className={`ui-button ui-button-${variant} ${className}`} />
  );
});

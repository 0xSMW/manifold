import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "outline" | "danger" | "danger-outline" | "ghost";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }>(function Button({ variant = "secondary", className = "", type = "button", ...props }, ref) {
  return <button className={`cp-button ${className}`} data-variant={variant} ref={ref} type={type} {...props} />;
});

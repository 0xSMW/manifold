import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = "", ...props }, ref) { return <input className={`cp-input ${className}`} ref={ref} {...props} />; });
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className = "", ...props }, ref) { return <select className={`cp-select ${className}`} ref={ref} {...props} />; });

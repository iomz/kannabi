import type { InputHTMLAttributes, ReactNode } from 'react';

export function Switch({ label, className, ...input }: {
  label: ReactNode;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>) {
  return <label className={['switch', className].filter(Boolean).join(' ')}>
    <input {...input} type="checkbox" role="switch" />
    <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    <span className="switch-label">{label}</span>
  </label>;
}

import type { ReactNode } from 'react';
import { BrandMark } from '@/marketing/brand';

/** Centered card layout used by the login and signup screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="text-accent"><BrandMark size={20} /></span>
          <span className="text-[15px] font-semibold tracking-tight">acruxcore</span>
        </div>
        <div className="rounded-xl border border-line bg-surface p-6">
          <h1 className="text-[18px] font-semibold text-ink">{title}</h1>
          <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-4 text-center text-[13px] text-muted">{footer}</p>
      </div>
    </div>
  );
}

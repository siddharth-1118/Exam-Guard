'use client';

import { Alert } from '@examguard/ui';

export function ErrorMessage({ message }: { message?: string }) {
  return (
    <Alert tone="danger">
      {message ??
        'Something went wrong. Your session is being recovered — try refreshing the page.'}
    </Alert>
  );
}
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ExamGuard — Admin Portal',
  description: 'Secure online examination and proctoring platform — administration',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
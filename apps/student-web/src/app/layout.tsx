import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ExamGuard — Student',
  description: 'Secure online examination platform — student portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
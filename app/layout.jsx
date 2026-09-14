import './globals.css';
import { ThemeProvider } from '@/components/focus/theme';
export const metadata = {
  title: 'Focus',
  description: 'Context, decisions, and commitments in one place.',
};
export default function Layout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

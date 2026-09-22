import '@radix-ui/themes/styles.css';
import './globals.css';
import '@/components/focus/priorities.css';
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

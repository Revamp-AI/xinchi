'use client';

import { useEffect, useState } from 'react';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from '@/components/ui/menu';

export function ThemeProvider({ children }) {
  return (
    <NextThemesProvider
      attribute="class"
      storageKey="focus-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const Icon =
    mounted && theme === 'dark'
      ? Moon
      : mounted && theme === 'light'
        ? Sun
        : Monitor;

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon" />}
        aria-label="Change appearance"
        title="Appearance"
        disabled={!mounted}
      >
        <Icon />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-40">
        <MenuRadioGroup
          aria-label="Appearance"
          value={mounted ? theme : 'system'}
          onValueChange={setTheme}
        >
          <MenuRadioItem value="light">
            <span className="theme-option">
              <Sun />
              Light
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="dark">
            <span className="theme-option">
              <Moon />
              Dark
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="system">
            <span className="theme-option">
              <Monitor />
              System
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

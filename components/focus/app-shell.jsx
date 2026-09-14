'use client';

import {
  ArrowDownToLine,
  BookOpen,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Layers3,
  LogOut,
  Plug,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
  MenuLinkItem,
} from '@/components/ui/menu';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Brand, StatusBadge, countSources } from './shared';
import { ThemeToggle } from './theme';

const views = [
  ['agent', Sparkles, 'Overview'],
  ['board', CheckCheck, 'Commitments'],
  ['contacts', Users, 'Contacts'],
  ['library', BookOpen, 'Context library'],
  ['connections', Plug, 'Connections'],
];
function Navigation({ view, onViewChange, state, busy, onLogout }) {
  const { setOpenMobile } = useSidebar();
  function navigate(next) {
    onViewChange(next);
    setOpenMobile(false);
  }
  const firstName = state.user?.name?.split(' ')[0] || 'Your';
  return (
    <Sidebar collapsible="offcanvas" className="focus-sidebar">
      <SidebarHeader className="sidebar-brand">
        <Brand />
      </SidebarHeader>
      <SidebarContent>
        <div className="workspace-label">
          <span className="workspace-monogram">{firstName[0]}</span>
          <div>
            <strong>
              {firstName === 'Your'
                ? 'Your workspace'
                : firstName + '’s workspace'}
            </strong>
            <span>Personal workspace</span>
          </div>
        </div>
        <SidebarGroup>
          <SidebarGroupLabel>WORKSPACE</SidebarGroupLabel>
          <SidebarMenu>
            {views.map(([id, Icon, label]) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton
                  isActive={view === id}
                  onClick={() => navigate(id)}
                  aria-current={view === id ? 'page' : undefined}
                  className="focus-nav-item"
                >
                  <Icon />
                  <span>{label}</span>
                  {id === 'agent' && state.proposals.length > 0 && (
                    <span className="nav-count">{state.proposals.length}</span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <div className="sidebar-context">
          <Layers3 size={16} />
          <div>
            <strong>{countSources(state).toLocaleString()} sources</strong>
            <p>Your context, in one place.</p>
          </div>
          <span className="live-dot" />
        </div>
      </SidebarContent>
      <SidebarFooter className="focus-sidebar-footer">
        <div className="sidebar-principle">
          <CircleHelp size={15} />
          <p>
            Fewer commitments.
            <br />
            <strong>More follow-through.</strong>
          </p>
        </div>
        <Separator />
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost" className="account-menu" />}
          >
            <Avatar className="size-8">
              <AvatarFallback>{firstName[0]}</AvatarFallback>
            </Avatar>
            <span>
              <strong>{state.user?.name || 'Your account'}</strong>
              <small>Workspace settings</small>
            </span>
            <ChevronDown size={15} />
          </MenuTrigger>
          <MenuPopup side="top" align="start" className="min-w-60">
            <div className="account-email">{state.user?.email}</div>
            <MenuSeparator />
            <MenuItem onClick={() => navigate('connections')}>
              <Plug />
              Manage connections
            </MenuItem>
            <MenuLinkItem href="/api/export">
              <ArrowDownToLine />
              Export workspace
            </MenuLinkItem>
            <MenuSeparator />
            <MenuItem disabled={busy} onClick={onLogout}>
              <LogOut />
              Sign out
            </MenuItem>
          </MenuPopup>
        </Menu>
      </SidebarFooter>
    </Sidebar>
  );
}
export default function AppShell({
  connectionLost,
  view,
  onViewChange,
  state,
  busy,
  onLogout,
  children,
}) {
  const activeImports = state.sync.filter((run) => run.state === 'running');
  return (
    <TooltipProvider>
      <SidebarProvider style={{ '--sidebar-width': '15rem' }}>
        <Navigation {...{ view, onViewChange, state, busy, onLogout }} />
        <SidebarInset className="focus-main">
          <header className="workspace-topbar">
            <div className="breadcrumb">
              <SidebarTrigger />
              <Separator orientation="vertical" className="h-4" />
              <span>Workspace</span>
              <span className="breadcrumb-slash">/</span>
              <strong>{views.find(([id]) => id === view)?.[2]}</strong>
            </div>
            <div className="topbar-status">
              {connectionLost ? (
                <StatusBadge tone="warning">Connection interrupted</StatusBadge>
              ) : activeImports.length > 0 ? (
                <StatusBadge tone="info" dot>
                  Importing context
                </StatusBadge>
              ) : (
                <span className="local-status">
                  <span className="live-dot" />
                  Saved in Postgres
                </span>
              )}
              <ThemeToggle />
            </div>
          </header>
          <div id="main-content" className="workspace-content">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

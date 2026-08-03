import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { Spinner } from '@/ui';
import { AppShell } from './AppShell';

/**
 * Gate for authenticated app routes. Shows a spinner during the initial
 * `/auth/me` check, redirects to `/login` when signed out (preserving the
 * intended path), and otherwise renders the app shell with the matched route.
 */
export function ProtectedRoute() {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <AppShell />;
}

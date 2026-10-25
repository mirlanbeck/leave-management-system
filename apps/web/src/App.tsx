import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { ApprovalsPage, HrPage } from './pages/StubPages';
import { RequireAuth, RequireRole } from './routes/guards';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route index element={<ProfilePage />} />
            <Route element={<RequireRole route="approvals" />}>
              <Route path="approvals" element={<ApprovalsPage />} />
            </Route>
            <Route element={<RequireRole route="hr" />}>
              <Route path="hr" element={<HrPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

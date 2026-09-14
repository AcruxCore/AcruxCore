import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { ScrollToTop } from './ScrollToTop';
import { LoginPage } from '@/auth/LoginPage';
import { SignupPage } from '@/auth/SignupPage';
import { AuthCallbackPage } from '@/auth/AuthCallbackPage';
import { VerifyEmailPage } from '@/auth/VerifyEmailPage';
import { WelcomePage } from '@/auth/WelcomePage';
import { FirstRunPage } from '@/auth/FirstRunPage';
import { ResetPasswordRequestPage } from '@/auth/ResetPasswordRequestPage';
import { ResetPasswordUpdatePage } from '@/auth/ResetPasswordUpdatePage';
import { AcceptInvitePage } from '@/auth/AcceptInvitePage';
import { PromptListPage } from '@/prompts/PromptListPage';
import { PromptDetailPage } from '@/prompts/PromptDetailPage';
import { TeamPage } from '@/team/TeamPage';
import { TeamAuditPage } from '@/team/audit';
import { AccountPage } from '@/account/AccountPage';
import { PlaygroundPage } from '@/gateway/PlaygroundPage';
import { UsagePage } from '@/gateway/UsagePage';
import { ConnectionsPage } from '@/gateway/ConnectionsPage';
import { ModelsPage } from '@/gateway/ModelsPage';
import { VirtualKeysPage } from '@/gateway/VirtualKeysPage';
import { BudgetsPage } from '@/gateway/BudgetsPage';
import { ToolsPage } from '@/tools/ToolsPage';
import { ToolDetailPage } from '@/tools/ToolDetailPage';
import { SecretsPage } from '@/secrets/SecretsPage';
import {
  TraceDetailPage,
  TraceListPage,
  SessionsPage,
  SessionDetailPage,
  DashboardsPage,
  TraceSettingsPage,
  FeedbackListPage,
} from '@/traces';
import {
  DatasetsPage,
  DatasetDetailPage,
  ExperimentConfigPage,
  RunHistoryPage,
  RunReportPage,
  RulesPage,
} from '@/evaluations';
import {
  RootRoute,
  AboutPage,
  ContactPage,
  SecurityPage,
  PrivacyPage,
  TermsPage,
  PricingPage,
  SdkPage,
  NotFoundPage,
  FeaturePage,
  FEATURE_LIST,
  ComparePage,
  FaqPage,
  BestLlmOpsPlatformsPage,
} from '@/marketing';

/**
 * Sends a bookmarked `/gateway/tools/:id` on to the tool's new home, keeping the id.
 * A plain `<Navigate>` cannot: the target path depends on the matched param.
 */
function LegacyToolRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/tools/${id}`} replace />;
}

/** Top-level route table: public marketing + auth routes, then protected app shell routes. */
export function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
      <Route path="/" element={<RootRoute />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/contact" element={<ContactPage />} />
      <Route path="/security" element={<SecurityPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/sdk" element={<SdkPage />} />
      {/* One page per platform pillar, generated from the same list that drives the
          footer and the prerender manifest so the three cannot drift apart. */}
      {FEATURE_LIST.map((feature) => (
        <Route key={feature.slug} path={`/features/${feature.slug}`} element={<FeaturePage feature={feature} />} />
      ))}
      <Route path="/compare" element={<ComparePage />} />
      <Route path="/faq" element={<FaqPage />} />
      <Route
        path="/best-open-source-llmops-platforms"
        element={<BestLlmOpsPlatformsPage />}
      />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/welcome" element={<WelcomePage />} />
      <Route path="/reset-password" element={<ResetPasswordRequestPage />} />
      <Route path="/reset-password/update" element={<ResetPasswordUpdatePage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      {/* Reached only from the one-time URL the API prints at boot on a fresh
          self-hosted install. Public by necessity: no account exists yet. */}
      <Route path="/first-run" element={<FirstRunPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/prompts" element={<PromptListPage />} />
        <Route path="/prompts/:id" element={<PromptDetailPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/team/audit" element={<TeamAuditPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/gateway" element={<Navigate to="/gateway/playground" replace />} />
        <Route path="/gateway/playground" element={<PlaygroundPage />} />
        <Route path="/gateway/usage" element={<UsagePage />} />
        <Route path="/gateway/connections" element={<ConnectionsPage />} />
        <Route path="/gateway/secrets" element={<SecretsPage />} />
        <Route path="/gateway/models" element={<ModelsPage />} />
        <Route path="/gateway/keys" element={<VirtualKeysPage />} />
        <Route path="/gateway/budgets" element={<BudgetsPage />} />
        {/* Tools sit beside Prompts, not under Gateway: they are something you author,
            and the gateway is only one of several things that can call them. The old
            paths still resolve so links, bookmarks and older docs keep working. */}
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/tools/:id" element={<ToolDetailPage />} />
        <Route path="/gateway/tools" element={<Navigate to="/tools" replace />} />
        <Route path="/gateway/tools/analytics" element={<Navigate to="/tools?tab=analytics" replace />} />
        <Route path="/gateway/tools/:id" element={<LegacyToolRedirect />} />
        <Route path="/traces" element={<TraceListPage />} />
        <Route path="/traces/:id" element={<TraceDetailPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/observability" element={<DashboardsPage />} />
        <Route path="/observability/feedback" element={<FeedbackListPage />} />
        <Route path="/observability/settings" element={<TraceSettingsPage />} />
        <Route path="/evaluations" element={<DatasetsPage />} />
        <Route path="/evaluations/datasets/:id" element={<DatasetDetailPage />} />
        <Route path="/evaluations/datasets/:id/run" element={<ExperimentConfigPage />} />
        <Route path="/evaluations/runs" element={<RunHistoryPage />} />
        <Route path="/evaluations/runs/:id" element={<RunReportPage />} />
        <Route path="/evaluations/rules" element={<RulesPage />} />
      </Route>

      {/* A genuinely unknown path gets a real 404 page. It used to redirect to
          /prompts, which bounced signed-out visitors to the login screen and made a
          mistyped URL look like a sign-in wall. */}
      <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}

import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AuthProvider, RequireAuth } from "@/components/auth";
import { Shell } from "@/components/Shell";
import { LoginPage } from "@/pages/LoginPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { InsightsPage } from "@/pages/InsightsPage";
import { InsightDetailPage } from "@/pages/InsightDetailPage";
import { ReportPage } from "@/pages/ReportPage";
import { AskPage } from "@/pages/AskPage";
import { SourcesPage } from "@/pages/SourcesPage";
import { EvaluationPage } from "@/pages/EvaluationPage";
import { ResearchPage } from "@/pages/ResearchPage";
import AnimatedLogo from "@/components/ui/loader";
import "./index.css";

// Everything except /login sits behind RequireAuth.
const router = createBrowserRouter([
  {
    element: <AuthProvider />,
    children: [
      { path: "/login", element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            path: "/",
            element: <Shell />,
            children: [
              { index: true, element: <OverviewPage /> },
              { path: "insights", element: <InsightsPage /> },
              { path: "insights/:id", element: <InsightDetailPage /> },
              { path: "report", element: <ReportPage /> },
              { path: "ask", element: <AskPage /> },
              { path: "sources", element: <SourcesPage /> },
              { path: "evaluation", element: <EvaluationPage /> },
              { path: "research", element: <ResearchPage /> },
            ],
          },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

const root = ReactDOM.createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <>
      <RouterProvider router={router} />
      <AnimatedLogo />
    </>
  </React.StrictMode>,
);

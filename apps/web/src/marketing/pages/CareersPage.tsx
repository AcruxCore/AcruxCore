import { type ReactNode } from 'react';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { cssToStyle, AI_AGENT_ENGINEER_FORM_URL } from '../marketing-chrome';

/**
 * Public "Careers" page. Lists every open role as its own `<h2>` block;
 * add more here as additional roles open.
 *
 * @returns The rendered Careers page.
 */
export function CareersPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Careers"
        docTitle="Careers — AcruxCore"
        title="Join AcruxCore."
        lead="We're a small team building an LLM-ops platform for engineering teams. Here's what's currently open."
      />
      <div className="acx-prose">
        <h2>AI Agent Engineer</h2>
        <p>
          Part-time (~4 hrs/day) or full-time (~8 hrs/day) — your choice. Remote, open to candidates based in{' '}
          <strong>Pakistan</strong>.
        </p>
        <p>
          AI agents are the fastest-moving, most in-demand part of AI right now, and this role puts you
          directly in that work. You'll beta test AcruxCore as a real user, build real agents with it, and —
          where it's useful for comparison — show how the same idea looks on a competing framework
          (LangChain, LlamaIndex, and others). That hands-on range across stacks is a rare, resume-defining
          skill in its own right, independent of where this specific role goes.
        </p>

        <div
          style={cssToStyle(
            'border:1px solid var(--line);background:var(--elevated);border-radius:12px;padding:18px 20px;margin:0 0 24px;',
          )}
        >
          <p style={cssToStyle('margin:0;color:var(--ink);')}>
            <strong>Important:</strong> we need someone who is proactive and takes ownership without needing
            to be micromanaged. We'll give you the product context and goals, but not a step-by-step task
            list — you should be comfortable figuring out what needs doing and working independently. If you
            need daily direction, this isn't the right fit.
          </p>
        </div>

        <h3>What you'd be doing</h3>
        <ul>
          <li>Beta test AcruxCore as a real user — file the bugs and rough edges you actually hit</li>
          <li>
            Build a real multi-prompt AI agent — not a single API call — using the AcruxCore SDK, in
            Node.js or Python
          </li>
          <li>
            Where it's useful for comparison, show the same idea on a competing tool (LangChain, LlamaIndex,
            or similar) — sometimes a full rebuild, sometimes just enough to demonstrate the difference
          </li>
          <li>Port the core agent logic to the other language (Node.js or Python) as a smaller companion piece</li>
          <li>
            Write a genuine tutorial about what you built — Medium, our blog, or any platform — real steps,
            real code, your own experience
          </li>
          <li>Create a YouTube walkthrough of what you built</li>
        </ul>

        <h3>What we're looking for</h3>
        <ul>
          <li>Working knowledge of Node.js or Python — comfortable in both is a strong plus</li>
          <li>Genuine curiosity about AI agents, and comfort exploring a new SDK and figuring things out</li>
          <li>Able to work independently without close supervision</li>
          <li>Based in Pakistan</li>
        </ul>

        <h3>Why you should join</h3>
        <p>
          AI agent engineering is the single most in-demand skill in AI hiring right now, and this role
          hands you real, hands-on practice building agents — not a course, not a toy project, a real
          product other teams actually use. You'll work directly with the founder on it, and as AcruxCore
          grows, your scope, your role, and your pay grow with it.
        </p>

        <div
          style={cssToStyle(
            'border:1px solid var(--line);background:var(--elevated);border-radius:12px;padding:18px 20px;margin:0 0 24px;',
          )}
        >
          <p style={cssToStyle('margin:0 0 12px;color:var(--ink);')}>
            <strong>Compensation:</strong> pick the track that fits you.
          </p>
          <ul style={cssToStyle('margin:0;padding-left:20px;color:var(--ink);')}>
            <li>
              <strong>Paid</strong> — a monthly rate agreed upfront, paid in full for every month you work.
              What's evaluated each month is only whether the role continues into the next one, with a
              possible shift to a permanent position after three consecutive good months. Tutorials, posts
              and videos you produce on this track are AcruxCore's IP, published under our own accounts.
            </li>
            <li>
              <strong>Unpaid (intern)</strong> — no pay, but you keep authorship: your tutorials, blog posts
              and YouTube videos are published under your own name and accounts, and become part of your
              own portfolio.
            </li>
          </ul>
        </div>

        <h3>To apply</h3>
        <p>
          Fill out this short form: <a href={AI_AGENT_ENGINEER_FORM_URL}>{AI_AGENT_ENGINEER_FORM_URL}</a>.
          Shortlisted candidates are then asked to complete a small take-home task — building a demo agent
          — as a follow-up step, not as part of the initial application.
        </p>
      </div>
    </MarketingShell>
  );
}

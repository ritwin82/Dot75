import type {Metadata} from "next";

export const metadata:Metadata={title:"PostgreSQL migration safety",description:"Dot75 executes related pull requests together in PostgreSQL and reports deterministic evidence before merge."};

export default function LandingPage(){
  return <>
    <section className="landing-hero page-width" id="product">
      <div className="hero-copy">
        <div className="kicker">Continuous PostgreSQL migration safety</div>
        <h1>Two pull requests.<br/>One database.<br/><span>Zero blind merges.</span></h1>
        <p>Dot75 tests related SQL migrations together in real PostgreSQL, catches order-dependent failures, and reports the evidence where your team reviews code.</p>
        <div className="hero-actions">
          <a className="primary-button" href="/dashboard">Open dashboard</a>
          <a className="secondary-link" href="#workflow">See how it works <span aria-hidden="true">↓</span></a>
        </div>
      </div>
      <div className="collision-map" aria-label="Two pull requests affecting the same database object">
        <div className="map-label">Dependency map</div>
        <div className="migration-node node-a"><span>PR A</span><b>Add status field</b><small>orders.status</small></div>
        <div className="migration-node node-b"><span>PR B</span><b>Replace status type</b><small>orders.status</small></div>
        <div className="object-node"><span>Shared object</span><b>orders.status</b></div>
        <div className="map-result"><span>Result</span><b>Order-dependent conflict</b><small>Verified in PostgreSQL</small></div>
        <svg viewBox="0 0 500 390" aria-hidden="true"><path d="M170 105 C250 105 230 195 305 195"/><path d="M170 290 C250 290 230 205 305 205"/><path d="M366 225 L366 286"/></svg>
      </div>
    </section>

    <section className="problem-section" id="why">
      <div className="page-width problem-grid">
        <div><div className="section-index">01 / The problem</div><h2>Git understands files.<br/>Your database understands consequences.</h2></div>
        <div className="problem-copy"><p>Two migrations can be valid alone and still fail when they reach the same database. Renamed columns, changed enums, dependent views, and reordered data updates can pass isolated checks while creating a broken merge.</p><blockquote>Dot75 finds the conflicts that clean Git diffs leave behind.</blockquote></div>
      </div>
    </section>

    <section className="workflow-section page-width" id="workflow">
      <div className="section-intro"><div className="section-index">02 / How it works</div><h2>Every relevant order.<br/>One deterministic answer.</h2><p>Dot75 narrows the search through PostgreSQL dependencies, then proves the result by executing the migrations.</p></div>
      <ol className="workflow-list">
        <li><span>01</span><div><h3>Rebuild the baseline</h3><p>Apply the target branch migrations to an isolated PostgreSQL database.</p></div></li>
        <li><span>02</span><div><h3>Trace affected objects</h3><p>Map tables, columns, constraints, views, functions, triggers, policies, and dependencies.</p></div></li>
        <li><span>03</span><div><h3>Test both orders</h3><p>Run related pull requests as A then B and B then A, including contracts and rollback checks.</p></div></li>
        <li><span>04</span><div><h3>Publish the evidence</h3><p>Send the exact failure, affected objects, and reproduction details to a required GitHub Check.</p></div></li>
      </ol>
    </section>

    <section className="reasons-section">
      <div className="page-width reasons-grid">
        <div className="reasons-heading"><div className="section-index">03 / Why Dot75</div><h2>Confidence built from execution, not guesswork.</h2></div>
        <div className="reason"><span>01</span><h3>Cross-PR awareness</h3><p>Test migrations against the open work they can actually collide with.</p></div>
        <div className="reason"><span>02</span><h3>Real PostgreSQL</h3><p>Use the configured database version and extensions instead of SQL-text heuristics.</p></div>
        <div className="reason"><span>03</span><h3>Contract protection</h3><p>Verify schema expectations and fixture-backed data behavior before merge.</p></div>
        <div className="reason"><span>04</span><h3>Rollback evidence</h3><p>Compare schema and fixture state after down migrations and flag destructive changes.</p></div>
      </div>
    </section>

    <section className="authority-section">
      <div className="page-width authority-grid">
        <div><div className="section-index">04 / Clear authority</div><h2>AI explains.<br/>Evidence decides.</h2></div>
        <div><p>Every pass or failure comes from PostgreSQL execution, normalized catalog differences, and deterministic contracts. A local Ollama model can make verified failures easier to understand and suggest repair SQL, but it never controls the result.</p><div className="authority-pair"><span><b>Deterministic engine</b>Required for every result</span><span><b>Local AI</b>Optional and advisory</span></div></div>
      </div>
    </section>

    <section className="setup-section page-width">
      <div className="section-intro"><div className="section-index">05 / Get started</div><h2>Keep the workflow in GitHub.</h2><p>Run Dot75 on your own infrastructure and connect it to the repositories you want to protect.</p></div>
      <ol className="setup-list"><li><span>01</span><div><b>Connect your GitHub account</b><p>Sign in and install the LocalMesh GitHub App on all repositories or a selected set.</p></div></li><li><span>02</span><div><b>Receive automatic reviews</b><p>Pull requests and merge queues trigger isolated PostgreSQL checks through signed webhooks.</p></div></li><li><span>03</span><div><b>Review one evidence stream</b><p>GitHub Checks, sticky comments, and the hosted dashboard share the same verified result.</p></div></li></ol>
    </section>

    <section className="landing-cta"><div className="page-width"><div><span>Ready to inspect your installation?</span><h2>See every migration check in one place.</h2></div><a className="light-button" href="/dashboard">Open dashboard</a></div></section>
  </>;
}

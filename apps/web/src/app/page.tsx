import { INCIDENT_TYPES } from "@selfheal/shared";

export default function HomePage() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Engineering foundation</p>
        <h1 id="page-title">SelfHeal</h1>
        <p className="summary">
          A safety-first foundation for diagnosing and recovering Docker-deployed applications.
        </p>
        <div className="status" role="status">
          Phase 1 foundation ready for local development
        </div>
      </section>

      <section className="card" aria-labelledby="coverage-title">
        <h2 id="coverage-title">Planned incident coverage</h2>
        <ul>
          {INCIDENT_TYPES.map((incidentType) => (
            <li key={incidentType}>{incidentType.replaceAll("_", " ")}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}


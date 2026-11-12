/**
 * Métricas simples, em memória, expostas em /metrics (formato Prometheus).
 *
 * Observação importante: são métricas POR INSTÂNCIA (o desafio pede "poucas
 * métricas"). Elas servem para diagnóstico local; em produção com várias
 * instâncias o ideal seria exportar para um Prometheus/Pushgateway, mas isso
 * está fora do escopo (documentado em ARCHITECTURE.md).
 */
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { count: number; sum: number; buckets: number[] }>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(this.key(name, labels), value);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const entry = this.histograms.get(key) ?? { count: 0, sum: 0, buckets: [] };
    entry.count += 1;
    entry.sum += value;
    entry.buckets.push(value);
    this.histograms.set(key, entry);
  }

  /** Snapshot numérico (usado por testes e pelo readiness). */
  getCounter(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  getGauge(name: string, labels: Record<string, string> = {}): number {
    return this.gauges.get(this.key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];

    for (const [key, value] of this.counters) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, entry] of this.histograms) {
      const [name] = key.split('{');
      lines.push(`${name}_count ${entry.count}`);
      lines.push(`${name}_sum ${entry.sum}`);
    }

    return lines.join('\n') + '\n';
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return name;
    const rendered = entries.map(([k, v]) => `${k}="${v}"`).join(',');
    return `${name}{${rendered}}`;
  }
}

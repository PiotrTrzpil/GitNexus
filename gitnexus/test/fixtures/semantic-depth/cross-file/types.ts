export interface Config { retries: number; timeout: number; }
export class HttpClient {
  private baseUrl: string;
  constructor(private config: Config) {}
  get(path: string): Promise<Response> { /* ... */ }
}

import { HttpClient, Config } from './types';

class ApiService {
  constructor(private client: HttpClient) {}

  fetchUser(id: string) {
    return this.client.get(`/users/${id}`);   // CALLS to HttpClient.get
  }
}

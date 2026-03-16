interface Serializable { toJSON(): string; }
class AppError extends Error { code: number; }
class NotFoundError extends AppError {}

class UserRepo {
  find(id: string): User | null { /* ... */ }
  save(user: User): void {
    if (!user.id) throw new NotFoundError('missing id');
  }
}

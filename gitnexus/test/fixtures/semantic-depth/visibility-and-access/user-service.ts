class User {
  public name: string;
  private email: string;
  protected age: number;
  #ssn: string;                    // JS private field
  readonly id: string;
  static count = 0;

  get fullName() { return this.name; }
  set fullName(v: string) { this.name = v; }

  private validate() { return this.#ssn.length > 0; }
}

class UserService {
  doStuff(user: User) {
    console.log(user.name);        // public read — ok
    console.log(user.email);       // private read — encapsulation violation
    user.age = 30;                 // protected write — encapsulation violation
  }
}

// Ambient TypeScript declarations for Vite environment variables and external modules
// when node_modules is not yet installed locally.

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface IntrinsicElementEvent<T = any> {
  target: EventTarget & T;
  currentTarget: EventTarget & T;
  preventDefault(): void;
  stopPropagation(): void;
}

interface IntrinsicElementAttributes<T = HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement & HTMLElement> {
  key?: string | number | null | undefined;
  ref?: any;
  children?: any;
  onChange?: (e: IntrinsicElementEvent<T>) => void;
  onInput?: (e: IntrinsicElementEvent<T>) => void;
  onClick?: (e: IntrinsicElementEvent<T> & { clientX: number; clientY: number }) => void;
  onSubmit?: (e: IntrinsicElementEvent<T>) => void;
  onBlur?: (e: IntrinsicElementEvent<T>) => void;
  onFocus?: (e: IntrinsicElementEvent<T>) => void;
  onKeyDown?: (e: IntrinsicElementEvent<T> & { key: string; code: string }) => void;
  onKeyUp?: (e: IntrinsicElementEvent<T> & { key: string; code: string }) => void;
  [attr: string]: any;
}

declare namespace JSX {
  type Element = any;
  type ElementType = any;
  interface ElementClass {
    render: any;
  }
  interface ElementAttributesProperty {
    props: {};
  }
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: string | number | null | undefined;
  }
  interface IntrinsicClassAttributes<T> {
    ref?: T | any;
  }
  interface IntrinsicElements {
    input: IntrinsicElementAttributes<HTMLInputElement>;
    select: IntrinsicElementAttributes<HTMLSelectElement>;
    textarea: IntrinsicElementAttributes<HTMLTextAreaElement>;
    form: IntrinsicElementAttributes<HTMLFormElement>;
    button: IntrinsicElementAttributes<HTMLButtonElement>;
    [elemName: string]: IntrinsicElementAttributes<any>;
  }
}

declare module 'react' {
  export type ReactNode = any;
  export type ReactElement = any;
  export type Key = string | number;

  export interface RefObject<T> {
    current: T;
  }
  export interface MutableRefObject<T> {
    current: T;
  }
  export type Ref<T> = RefObject<T> | ((instance: T | null) => void) | null | undefined;

  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prevState: S) => S);

  export interface Context<T> {
    Provider: (props: { value: T; children?: ReactNode }) => any;
    Consumer?: any;
  }

  export interface FormEvent<T = Element> {
    preventDefault(): void;
    stopPropagation(): void;
    currentTarget: EventTarget & T;
    target: EventTarget & T;
  }

  export interface ChangeEvent<T = Element> {
    preventDefault(): void;
    stopPropagation(): void;
    currentTarget: EventTarget & T;
    target: EventTarget & T;
  }

  export interface MouseEvent<T = Element> {
    preventDefault(): void;
    stopPropagation(): void;
    currentTarget: EventTarget & T;
    target: EventTarget & T;
    clientX: number;
    clientY: number;
  }

  export interface KeyboardEvent<T = Element> {
    key: string;
    code: string;
    preventDefault(): void;
    stopPropagation(): void;
  }

  export type CSSProperties = Record<string, string | number | undefined>;

  export function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useRef<T>(initialValue: T): MutableRefObject<T>;
  export function useRef<T>(initialValue: T | null): RefObject<T>;
  export function useContext<T>(context: Context<T>): T;
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useSyncExternalStore<Snapshot>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot?: () => Snapshot,
  ): Snapshot;

  export function StrictMode(props: { children?: ReactNode }): any;
  export function Fragment(props: { children?: ReactNode }): any;

  export namespace JSX {
    type Element = any;
    type ElementType = any;
    interface ElementClass {
      render: any;
    }
    interface ElementAttributesProperty {
      props: {};
    }
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicAttributes {
      key?: string | number | null | undefined;
    }
    interface IntrinsicClassAttributes<T> {
      ref?: T | any;
    }
    interface IntrinsicElements {
      input: IntrinsicElementAttributes<HTMLInputElement>;
      select: IntrinsicElementAttributes<HTMLSelectElement>;
      textarea: IntrinsicElementAttributes<HTMLTextAreaElement>;
      form: IntrinsicElementAttributes<HTMLFormElement>;
      button: IntrinsicElementAttributes<HTMLButtonElement>;
      [elemName: string]: IntrinsicElementAttributes<any>;
    }
  }
}

declare module 'react/jsx-runtime' {
  export const Fragment: any;
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
  export namespace JSX {
    type Element = any;
    type ElementType = any;
    interface ElementClass {
      render: any;
    }
    interface ElementAttributesProperty {
      props: {};
    }
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicAttributes {
      key?: string | number | null | undefined;
    }
    interface IntrinsicClassAttributes<T> {
      ref?: T | any;
    }
    interface IntrinsicElements {
      input: IntrinsicElementAttributes<HTMLInputElement>;
      select: IntrinsicElementAttributes<HTMLSelectElement>;
      textarea: IntrinsicElementAttributes<HTMLTextAreaElement>;
      form: IntrinsicElementAttributes<HTMLFormElement>;
      button: IntrinsicElementAttributes<HTMLButtonElement>;
      [elemName: string]: IntrinsicElementAttributes<any>;
    }
  }
}

declare module 'react/jsx-dev-runtime' {
  export const Fragment: any;
  export function jsxDEV(
    type: any,
    props: any,
    key?: any,
    isStaticChildren?: boolean,
    source?: any,
    self?: any,
  ): any;
  export namespace JSX {
    type Element = any;
    type ElementType = any;
    interface ElementClass {
      render: any;
    }
    interface ElementAttributesProperty {
      props: {};
    }
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicAttributes {
      key?: string | number | null | undefined;
    }
    interface IntrinsicClassAttributes<T> {
      ref?: T | any;
    }
    interface IntrinsicElements {
      input: IntrinsicElementAttributes<HTMLInputElement>;
      select: IntrinsicElementAttributes<HTMLSelectElement>;
      textarea: IntrinsicElementAttributes<HTMLTextAreaElement>;
      form: IntrinsicElementAttributes<HTMLFormElement>;
      button: IntrinsicElementAttributes<HTMLButtonElement>;
      [elemName: string]: IntrinsicElementAttributes<any>;
    }
  }
}

declare module 'react-dom/client' {
  export interface Root {
    render(children: any): void;
    unmount(): void;
  }
  export function createRoot(container: Element | DocumentFragment): Root;
}

declare module 'react-router-dom' {
  export interface Location {
    pathname: string;
    search: string;
    hash: string;
    state: unknown;
    key: string;
  }

  export interface NavigateOptions {
    replace?: boolean;
    state?: unknown;
  }

  export interface NavigateFunction {
    (to: string, options?: NavigateOptions): void;
    (delta: number): void;
  }

  export function BrowserRouter(props: { children?: any }): any;
  export function Routes(props: { children?: any }): any;
  export function Route(props: {
    path?: string;
    index?: boolean;
    element?: any;
    children?: any;
  }): any;
  export function Link(props: {
    to: string;
    state?: unknown;
    replace?: boolean;
    className?: string;
    style?: Record<string, string | number | undefined>;
    title?: string;
    'aria-label'?: string;
    children?: any;
    onClick?: (e: any) => void;
    [attr: string]: any;
  }): any;
  export function NavLink(props: {
    to: string;
    end?: boolean;
    className?: string | ((props: { isActive: boolean; isPending: boolean }) => string);
    style?:
      | Record<string, string | number | undefined>
      | ((props: { isActive: boolean; isPending: boolean }) => Record<string, string | number | undefined> | undefined);
    title?: string;
    'aria-label'?: string;
    children?: any;
    onClick?: (e: any) => void;
    [attr: string]: any;
  }): any;
  export function Navigate(props: { to: string; replace?: boolean; state?: unknown }): any;
  export function Outlet(props?: { context?: unknown }): any;

  export function useLocation(): Location;
  export function useNavigate(): NavigateFunction;
  export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T;
  export function useSearchParams(
    defaultInit?: Record<string, string> | string | URLSearchParams,
  ): [URLSearchParams, (nextInit?: any, navigateOpts?: NavigateOptions) => void];
}

declare module '@supabase/supabase-js' {
  export interface User {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
    created_at?: string;
  }

  export interface Session {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    user: User;
  }

  export interface SupabaseError {
    message: string;
    code?: string;
    details?: string;
    hint?: string;
  }

  export interface QueryResult<T = any> {
    data: T;
    error: SupabaseError | null;
    count?: number | null;
  }

  export interface SupabaseQueryBuilder<T = any> extends PromiseLike<QueryResult<T>> {
    select(columns?: string, options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): SupabaseQueryBuilder<T>;
    insert(values: Record<string, unknown> | Record<string, unknown>[]): SupabaseQueryBuilder<T>;
    update(values: Record<string, unknown>): SupabaseQueryBuilder<T>;
    delete(): SupabaseQueryBuilder<T>;
    eq(column: string, value: unknown): SupabaseQueryBuilder<T>;
    neq(column: string, value: unknown): SupabaseQueryBuilder<T>;
    in(column: string, values: readonly unknown[]): SupabaseQueryBuilder<T>;
    not(column: string, operator: string, value: unknown): SupabaseQueryBuilder<T>;
    lte(column: string, value: unknown): SupabaseQueryBuilder<T>;
    gte(column: string, value: unknown): SupabaseQueryBuilder<T>;
    order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilder<T>;
    limit(count: number): SupabaseQueryBuilder<T>;
    single(): Promise<QueryResult<T>>;
    maybeSingle(): Promise<QueryResult<T>>;
  }

  export interface RealtimePostgresChangesPayload<T = Record<string, unknown>> {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: T;
    old: Partial<T>;
    schema: string;
    table: string;
  }

  export interface RealtimeChannel {
    on(
      type: 'postgres_changes',
      filter: {
        event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
        schema: string;
        table?: string;
        filter?: string;
      },
      callback: (payload: RealtimePostgresChangesPayload<any>) => void,
    ): RealtimeChannel;
    on(
      type: 'presence',
      filter: { event: 'sync' | 'join' | 'leave' },
      callback: (payload?: any) => void,
    ): RealtimeChannel;
    on(
      type: 'broadcast',
      filter: { event: string },
      callback: (message: { event: string; type: string; payload: any }) => void,
    ): RealtimeChannel;
    subscribe(callback?: (status: string, err?: Error) => void): RealtimeChannel;
    track(payload: Record<string, unknown>): Promise<string>;
    untrack(): Promise<string>;
    presenceState<T = Record<string, unknown>>(): Record<string, T[]>;
    send(message: { type: 'broadcast'; event: string; payload?: unknown }): Promise<string>;
    unsubscribe(): Promise<string>;
  }

  export interface SupabaseClient {
    auth: {
      getSession(): Promise<{ data: { session: Session | null }; error: SupabaseError | null }>;
      onAuthStateChange(
        callback: (event: string, session: Session | null) => void,
      ): { data: { subscription: { unsubscribe(): void } } };
      signInWithPassword(credentials: {
        email: string;
        password: string;
      }): Promise<{ data: { user: User | null; session: Session | null }; error: SupabaseError | null }>;
      signUp(credentials: {
        email: string;
        password: string;
        options?: { data?: Record<string, unknown> };
      }): Promise<{ data: { user: User | null; session: Session | null }; error: SupabaseError | null }>;
      signOut(): Promise<{ error: SupabaseError | null }>;
    };
    from(table: string): SupabaseQueryBuilder<any>;
    rpc(fn: string, params?: Record<string, unknown>): Promise<QueryResult<any>>;
    channel(
      name: string,
      opts?: {
        config?: {
          private?: boolean;
          broadcast?: { self?: boolean; ack?: boolean };
          presence?: { key?: string };
        };
      },
    ): RealtimeChannel;
    removeChannel(channel: RealtimeChannel): Promise<string>;
    realtime: {
      setAuth(token: string | null): Promise<void>;
    };
    storage: {
      from(bucket: string): {
        getPublicUrl(path: string): { data: { publicUrl: string } };
        upload(
          path: string,
          file: File | Blob,
          options?: { cacheControl?: string; upsert?: boolean; contentType?: string },
        ): Promise<{ data: { path: string } | null; error: SupabaseError | null }>;
      };
    };
  }

  export function createClient(
    supabaseUrl: string,
    supabaseKey: string,
    options?: Record<string, unknown>,
  ): SupabaseClient;
}

declare module '*.css' {}
declare module '*.svg' {
  const src: string;
  export default src;
}

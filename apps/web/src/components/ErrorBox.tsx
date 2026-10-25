import { describeProblem, type ApiProblem } from '../api/problem';

export function ErrorBox({ problem }: { problem: ApiProblem }) {
  return (
    <p role="alert" className="error">
      {describeProblem(problem)}
    </p>
  );
}

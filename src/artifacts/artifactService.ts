import type { ArtifactRecord } from "@shared/types";
import type { ArtifactRepository } from "@persistence/artifactRepository";

export class ArtifactService {
  constructor(private readonly repository: ArtifactRepository) {}

  list(): ArtifactRecord[] {
    return this.repository.listArtifacts();
  }
}

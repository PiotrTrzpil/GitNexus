import { generateId } from "../../lib/utils.js";
import { KnowledgeGraph, GraphNode, GraphRelationship, NodeProperties } from "../graph/types.js";

export interface StructureEntry {
    path: string;
    /** File size in bytes (omit for entries that are pure path strings). */
    size?: number;
}

export const processStructure = (
    graph: KnowledgeGraph,
    entries: ReadonlyArray<string | StructureEntry>,
) => {
    entries.forEach( entry => {
        const path = typeof entry === 'string' ? entry : entry.path;
        const fileSize = typeof entry === 'string' ? undefined : entry.size;
        const parts = path.split('/')
        let currentPath = ''
        let parentId = ''

        parts.forEach( (part, index ) => {
            const isFile = index === parts.length - 1
            const label = isFile ? 'File' : 'Folder'

            currentPath = currentPath ? `${currentPath}/${part}` : part

            const nodeId=generateId(label, currentPath)

            const properties: NodeProperties = {
                name: part,
                filePath: currentPath,
            }
            // sizeBytes lives on File nodes only — content can be truncated, this stays accurate.
            if (isFile && fileSize !== undefined) {
                properties.sizeBytes = fileSize
            }

            const node: GraphNode = {
                id: nodeId,
                label: label,
                properties,
            }
            graph.addNode(node)

            if(parentId){
                const relId = generateId('CONTAINS', `${parentId}->${nodeId}`)

                const relationship: GraphRelationship={
                    id: relId,
                    type: 'CONTAINS',
                    sourceId: parentId,
                    targetId: nodeId,
                    confidence: 1.0,
                    reason: '',
                }

                graph.addRelationship(relationship)
            }

            parentId = nodeId

        })
    })
}


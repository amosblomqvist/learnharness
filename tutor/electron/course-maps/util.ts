// Shared bits for the ready-made course maps.
import type { StrategyInput } from "../goals"

export type CourseNode = StrategyInput["nodes"][number]
export const R = (title: string, url: string) => ({ title, url })

// Official docs, by page.
export const PY = (page: string, title: string) => R(`Python docs: ${title}`, `https://docs.python.org/3/${page}`)
export const PYD = (page: string, title: string) => R(`Pydantic: ${title}`, `https://docs.pydantic.dev/latest/${page}`)
export const FA = (page: string, title: string) => R(`FastAPI: ${title}`, `https://fastapi.tiangolo.com/${page}`)
export const K8S = (page: string, title: string) => R(`Kubernetes: ${title}`, `https://kubernetes.io/docs/${page}`)
export const BR = (page: string, title: string) => R(`Bedrock: ${title}`, `https://docs.aws.amazon.com/bedrock/latest/userguide/${page}`)
export const AC = (page: string, title: string) => R(`AgentCore: ${title}`, `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/${page}`)
export const TF = (page: string, title: string) => R(`Terraform: ${title}`, `https://developer.hashicorp.com/terraform/${page}`)
export const LG = (page: string, title: string) => R(`LangGraph: ${title}`, `https://docs.langchain.com/oss/python/langgraph/${page}`)
export const AI = (page: string, title: string) => R(`AI SDK: ${title}`, `https://ai-sdk.dev/docs/${page}`)
export const MCP = (page: string, title: string) => R(`MCP: ${title}`, `https://modelcontextprotocol.io/${page}`)

// Every project from the Git & Docker course on ships with a Dockerfile.
export const DOCKER = " Ships with a Dockerfile (small, non-root) and runs with one command."

export const config = {
    runtime: 'edge',
};

export default async function handler(req: Request) {
    const url = new URL(req.url);

    const apiResponse = await fetch(`${url.origin}/_api.json`);

    if (!apiResponse.ok) {
        return new Response("Data not found", { status: 404 });
    }

    const providers = (await apiResponse.json()) as Record<
        string,
        { models: Record<string, unknown> }
    >;

    const modelIds: string[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
        for (const modelId of Object.keys(provider.models)) {
            modelIds.push(`${providerId}/${modelId}`);
        }
    }

    const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://models.dev/model-schema.json",
        $defs: {
            Model: {
                type: "string",
                enum: modelIds.sort(),
                description: "AI model identifier in provider/model format",
            },
        },
    };

    return new Response(JSON.stringify(schema, null, 2), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
        },
    });
}
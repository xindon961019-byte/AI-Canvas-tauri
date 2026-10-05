definePlugin({
  tools: {
    uppercase: async (input) => {
      const text = String(input.node.data.output ?? '');
      return { data: { output: text.toUpperCase() } };
    },
  },
});

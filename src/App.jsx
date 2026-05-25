import { motion } from "motion/react";

export default function App() {
  return (
    <main className="app">
      <section className="hero">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          One-Command Website Workflow
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          Run <code>npm run site:build</code> to generate your build prompt and
          start the full workflow.
        </motion.p>
      </section>
    </main>
  );
}


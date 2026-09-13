"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const timestamps = {
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      };
      const reference = (model, nullable = false) => ({
        type: Sequelize.UUID,
        allowNull: nullable,
        references: { model, key: "id" },
        onDelete: nullable ? "SET NULL" : "CASCADE",
      });
      await queryInterface.createTable(
        "table_scripts",
        {
          id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
          documentId: reference("documents"),
          teamId: reference("teams"),
          createdById: reference("users", true),
          scheduledById: reference("users", true),
          name: { type: Sequelize.STRING(100), allowNull: false },
          source: { type: Sequelize.BLOB, allowNull: false },
          revision: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 1,
          },
          cron: { type: Sequelize.STRING(100), allowNull: true },
          timezone: {
            type: Sequelize.STRING(100),
            allowNull: false,
            defaultValue: "UTC",
          },
          scheduleEnabled: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          nextRunAt: { type: Sequelize.DATE, allowNull: true },
          deletedAt: { type: Sequelize.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "table_scripts",
        ["documentId", "createdAt"],
        {
          transaction,
          where: { deletedAt: null },
        }
      );
      await queryInterface.addIndex("table_scripts", ["nextRunAt"], {
        transaction,
        where: { deletedAt: null, scheduleEnabled: true },
      });
      await queryInterface.createTable(
        "table_script_runs",
        {
          id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
          scriptId: reference("table_scripts"),
          documentId: reference("documents"),
          teamId: reference("teams"),
          actorId: reference("users", true),
          scriptRevision: { type: Sequelize.INTEGER, allowNull: false },
          documentRevision: { type: Sequelize.INTEGER, allowNull: true },
          source: { type: Sequelize.BLOB, allowNull: false },
          output: { type: Sequelize.BLOB, allowNull: false },
          status: {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: "queued",
          },
          trigger: { type: Sequelize.STRING(10), allowNull: false },
          startedAt: { type: Sequelize.DATE, allowNull: true },
          finishedAt: { type: Sequelize.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "table_script_runs",
        ["scriptId", "createdAt"],
        { transaction }
      );
      await queryInterface.addIndex(
        "table_script_runs",
        ["status", "createdAt"],
        { transaction }
      );
      await queryInterface.addIndex("table_script_runs", ["finishedAt"], {
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("table_script_runs", { transaction });
      await queryInterface.dropTable("table_scripts", { transaction });
    });
  },
};

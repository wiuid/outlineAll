"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "table_collaborations",
        {
          id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
          documentId: {
            type: Sequelize.UUID,
            allowNull: false,
            unique: true,
            references: { model: "documents", key: "id" },
            onDelete: "CASCADE",
          },
          state: { type: Sequelize.BLOB, allowNull: false },
          barrierRevision: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("table_collaborations");
  },
};
